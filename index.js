#!/usr/bin/env node

const _ = require("lodash");
const logger = require("debug");

const { makeBlastDb } = require("./src/blast");
const { HitsStore, streamFactory, runBlast, findGenesWithInexactResults, formatOutput } = require("./src/mlst");
const { findExactHits } = require("./src/exactHits");
const { fail } = require("./src/utils");
const { getMetadata } = require("./src/parseEnvVariables");

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const ALLELES_IN_FIRST_RUN = 5;

async function runMlst(inStream) {
  const [RUN_CORE_GENOME_MLST, alleleMetadata] = await getMetadata();

  const {
    lengths: alleleLengths,
    alleleLookup,
    alleleLookupPrefixLength,
    genes,
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
    const bestHits = await runBlast({ stream, blastDb, wordSize, pIdent, hitsStore });
    return bestHits
  }
  /* eslint-enable max-params */

  logger("debug:blast")("Running first round of blast");
  let bestHits = await runRound(20, 80, genes, 0, ALLELES_IN_FIRST_RUN);
  const inexactGenes = findGenesWithInexactResults(bestHits);
  if (inexactGenes.length > 0) {
    logger("debug:blast")("Running second round of blast");
    bestHits = await runRound(20, 80, inexactGenes, ALLELES_IN_FIRST_RUN, maxSeqs);
  }

  const output = formatOutput({ alleleMetadata, renamedSequences, bestHits });
  if (process.env.DEBUG) {
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
