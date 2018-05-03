#!/usr/bin/env node

const _ = require("lodash");
const logger = require("debug");

const { makeBlastDb } = require("./src/blast");
const { HitsStore } = require("./src/matches");
const { streamFactory, runBlast, buildResults } = require("./src/mlst");
const { findExactHits } = require("./src/exactHits");
const { fail } = require("./src/utils");
const { getMetadata } = require("./src/parseEnvVariables");

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const ALLELES_IN_FIRST_RUN = 5;

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

function formatOutput(alleleMetadata, results) {
  const { alleles, code, st } = results;
  const sortedAlleles = _(alleles)
    .toPairs()
    .map(([gene, hits]) => [
      gene,
      _.sortBy(hits, [hit => String(hit.id), "contig", "start"])
    ])
    .fromPairs()
    .value();
  const { schemeName, url, genes } = alleleMetadata;
  return {
    alleles: sortedAlleles,
    code,
    st,
    scheme: schemeName,
    url,
    genes
  };
}

async function runMlst(inStream) {
  const [RUN_CORE_GENOME_MLST, alleleMetadata] = await getMetadata();

  const {
    lengths: alleleLengths,
    alleleLookup,
    alleleLookupPrefixLength,
    genes,
    profiles,
    allelePaths,
    schemeName,
  } = alleleMetadata;
  const maxSeqs = alleleMetadata.maxSeqs || 0;

  logger("debug")(`Scheme '${schemeName}' has ${genes.length} genes`);

  const streamBuilder = streamFactory(allelePaths);
  const { contigNameMap, blastDb, renamedSequences } = await makeBlastDb(
    inStream
  );
  const hitsStore = new HitsStore(alleleLengths, contigNameMap);

  const exactHits = findExactHits(
    renamedSequences,
    alleleLookup,
    alleleLookupPrefixLength
  );
  _.forEach(exactHits, hit => hitsStore.add(hit));
  const matchedGenes = _.uniq(_.map(exactHits, ({ gene }) => gene));
  logger("debug:exactHits")(
    `Added exact matches for ${matchedGenes.length} out of ${genes.length} genes`
  );

  /* eslint-disable max-params */
  async function runRound(wordSize, pIdent, genesToImprove, start, end) {
    const stream = streamBuilder(genesToImprove, start, end);
    await runBlast({ stream, blastDb, wordSize, pIdent, hitsStore });
    const bestHits = hitsStore.best();
    return await buildResults({
      bestHits,
      alleleLengths,
      genes,
      profiles,
      scheme: schemeName,
      renamedSequences
    });
  }
  /* eslint-enable max-params */

  logger("debug:blast")("Running first round of blast");
  const firstRunResults = await runRound(20, 80, genes, 0, ALLELES_IN_FIRST_RUN);
  const inexactGenes = findGenesWithInexactResults(firstRunResults);
  let results;
  if (inexactGenes.length <= 0) {
    results = firstRunResults;
  } else {
    logger("debug:blast")("Running second round of blast");
    results = runRound(20, 80, inexactGenes, ALLELES_IN_FIRST_RUN, maxSeqs);
  }

  const output = formatOutput(alleleMetadata, results);
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
  return output;
}

module.exports = { runMlst };

if (require.main === module) {
  runMlst(process.stdin)
    .then(output => console.log(JSON.stringify(output)))
    .then(() => logger("info")("Done"))
    .catch(fail("RunAllBlast"));
}
