#!/usr/bin/env node

const _ = require("lodash");
const logger = require("debug");

const {
  PubMlstSevenGenomeSchemes,
  CgMlstMetadata
} = require("./src/mlst-database");
const { makeBlastDb } = require("./src/blast");
const { HitsStore } = require("./src/matches");
const { streamFactory, runBlast, buildResults } = require("./src/mlst");
const { findExactHits } = require("./src/exactHits");
const { DeferredPromise, fail } = require("./src/utils");

const DATA_DIR = "/opt/mlst/databases";

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const RUN_CORE_GENOME_MLST =
  (process.env.RUN_CORE_GENOME_MLST && true) || false;
let metadataSchemes;

if (RUN_CORE_GENOME_MLST) {
  metadataSchemes = new CgMlstMetadata(DATA_DIR);
} else {
  metadataSchemes = new PubMlstSevenGenomeSchemes(DATA_DIR);
}

const POSSIBLE_TAXID_ENVIRONMENT_VARIABLES = [
  "WGSA_ORGANISM_TAXID",
  "WGSA_SPECIES_TAXID",
  "WGSA_GENUS_TAXID"
];
let taxid;
let taxidVariableName;
let alleleMetadata;
_.forEach(POSSIBLE_TAXID_ENVIRONMENT_VARIABLES, variableName => {
  taxid = process.env[variableName] || null;
  alleleMetadata = metadataSchemes.read(taxid);
  if (alleleMetadata) {
    taxidVariableName = variableName;
    return false;
  }
  return true;
});

logger("params")({ taxidVariableName, taxid });

if (!alleleMetadata) {
  const taxIdEnvironmentVariables = _.zip(
    POSSIBLE_TAXID_ENVIRONMENT_VARIABLES,
    _.map(
      POSSIBLE_TAXID_ENVIRONMENT_VARIABLES,
      variable => process.env[variable]
    )
  );
  console.log(
    JSON.stringify({
      error: `Could not find MLST scheme:\n${JSON.stringify(
        taxIdEnvironmentVariables
      )}`
    })
  );
  process.exit(1);
}

const {
  lengths: alleleLengths,
  alleleLookup,
  alleleLookupPrefixLength,
  genes,
  profiles,
  allelePaths,
  scheme,
  commonGeneLengths,
  url
} = alleleMetadata;

logger("debug")(`${scheme} has ${allelePaths.length} genes`);

const NUMBER_OF_ALLELES = 5;
const streamBuilder = streamFactory(allelePaths);

const whenBlastDb = new DeferredPromise();
const whenRenamedSequences = new DeferredPromise();
const whenContigNameMap = new DeferredPromise();

makeBlastDb(process.stdin)
  .then(({ contigNameMap, blastDb, renamedSequences }) => {
    whenBlastDb.resolve(blastDb);
    whenRenamedSequences.resolve(renamedSequences);
    whenContigNameMap.resolve(contigNameMap);
  })
  .catch(fail("makeBlastDb"));

const whenExactHits = whenRenamedSequences
  .then(renamedSequences =>
    findExactHits(renamedSequences, alleleLookup, alleleLookupPrefixLength)
  )
  .catch(fail("exactHits"));

whenExactHits
  .then(hits => _.map(hits, ({ gene }) => gene))
  .then(matchedGenes => _.uniq(matchedGenes))
  .then(matchedGenes =>
    logger("debug:exactHits")(
      `Found exact matches for ${matchedGenes.length} out of ${genes.length} genes`
    )
  );

const whenHitsStore = whenContigNameMap.then(
  contigNameMap => new HitsStore(alleleLengths, contigNameMap)
);

const whenExactHitsAdded = Promise.all([
  whenHitsStore,
  whenExactHits
]).then(([hitsStore, hits]) => {
  _.forEach(hits, hit => hitsStore.add(hit));
});

/* eslint-disable max-params */
async function runRound(wordSize, pIdent, genesToImprove, start, end) {
  const hitsStore = await whenHitsStore;
  const db = await whenBlastDb;
  const renamedSequences = await whenRenamedSequences;
  const stream = streamBuilder(genesToImprove, start, end);
  await runBlast({ stream, db, wordSize, pIdent, hitsStore });
  const bestHits = hitsStore.best();
  return await buildResults({
    bestHits,
    alleleLengths,
    genes,
    profiles,
    scheme,
    commonGeneLengths,
    renamedSequences
  });
}
/* eslint-enable max-params */

function findGenesWithInexactResults(results) {
  const exactResultFilter = ([, [firstMatch, ...otherMatches]]) => {
    const exact = firstMatch && firstMatch.exact && otherMatches.length === 0;
    return !exact;
  };
  const inexactGenes = _(results.raw)
    .toPairs()
    .filter(exactResultFilter)
    .map(([gene]) => gene)
    .value();
  return inexactGenes;
}

async function runAllRounds() {
  logger("debug:blast")("Running first round of blast");
  const firstRunResults = await runRound(30, 80, genes, 0, NUMBER_OF_ALLELES);
  let inexactGenes = findGenesWithInexactResults(firstRunResults);
  if (inexactGenes.length <= 0) return firstRunResults;
  logger("debug:blast")("Running second round of blast");
  const secondRunResults = await runRound(
    20,
    80,
    inexactGenes,
    NUMBER_OF_ALLELES,
    50
  );
  if (RUN_CORE_GENOME_MLST) return secondRunResults;
  inexactGenes = findGenesWithInexactResults(secondRunResults);
  if (inexactGenes.length <= 0) return secondRunResults;
  logger("debug:blast")("Running third round of blast");
  const thirdRunResults = await runRound(20, 80, inexactGenes, 50, 0);
  return thirdRunResults;
}

function formatOutput(results) {
  const { alleles, code, st } = results;
  const sortedAlleles = _(alleles)
    .toPairs()
    .map(([gene, hits]) => [
      gene,
      _.sortBy(hits, [hit => String(hit.id), "contig", "start"])
    ])
    .fromPairs()
    .value();
  return {
    alleles: sortedAlleles,
    code,
    st,
    scheme,
    url,
    genes
  };
}

Promise.all([whenBlastDb, whenHitsStore, whenExactHitsAdded])
  .then(async ([, hitsStore]) => {
    const results = await runAllRounds();
    const output = formatOutput(results);
    if (process.env.DEBUG) {
      const sortedRaw = _(results.raw)
        .toPairs()
        .map(([gene, hits]) => [
          gene,
          _.sortBy(hits, hit => (hit.exact ? hit.st : hit.hash))
        ])
        .fromPairs()
        .value();
      output.raw = sortedRaw;
      output.bins = hitsStore._bins;
    }
    console.log(JSON.stringify(output));
  })
  .catch(logger("RunAllBlast"));
