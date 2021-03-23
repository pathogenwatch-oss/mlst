#!/usr/bin/env node

const _ = require("lodash");
const logger = require("debug");
const path = require("path");
const argv =  require("yargs")
  .boolean('cgmlst')
  .argv

const { makeBlastDb } = require("./src/blast");
const {
  HitsStore,
  streamFactory,
  findGenesWithInexactResults,
  formatOutput
} = require("./src/mlst");
const { findExactHits } = require("./src/exactHits");
const { fail } = require("./src/utils");
const { getMetadataPath, shouldRunCgMlst } = require("./src/parseEnvVariables");
const { readSchemePrefixes, readSchemeDetails } = require("./src/mlst-database");

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const ALLELES_IN_FIRST_RUN = 5;

async function runMlst(inStream, taxidEnvVariables) {
  const metadataPath = await getMetadataPath(taxidEnvVariables);

  const {
    alleleLookup,
    alleleLookupPrefixLength,
  } = await readSchemePrefixes(path.dirname(metadataPath))

  const exactHits = findExactHits(
    renamedSequences,
    alleleLookup,
    alleleLookupPrefixLength
  );

  delete(alleleLookup)

  const {
    lengths: alleleLengths,
    genes,
    allelePaths,
    name: schemeName,
    maxSeqs = 0
  } = await readSchemeDetails(metadataPath);

  logger("cgps:debug")(`Scheme '${schemeName}' has ${genes.length} genes`);

  const streamBuilder = streamFactory(allelePaths);
  const { contigNameMap, blastDb, renamedSequences } = await makeBlastDb(
    inStream
  );
  const hitsStore = new HitsStore(alleleLengths, contigNameMap);

  _.forEach(exactHits, hit => hitsStore.add(hit));
  const matchedGenes = _.uniq(_.map(exactHits, ({ gene }) => gene));
  logger("cgps:debug:exactHits")(
    `Added exact matches for ${matchedGenes.length} out of ${
      genes.length
    } genes`
  );

  /* eslint-disable max-params */
  async function runRound(wordSize, pIdent, genesToImprove, start, end) {
    const stream = streamBuilder(genesToImprove, start, end);
    await hitsStore.addFromBlast({ stream, blastDb, wordSize, pIdent });
    return hitsStore.best();
  }
  /* eslint-enable max-params */

  logger("cgps:debug:blast")("Running first round of blast");
  let bestHits = await runRound(30, 80, genes, 0, ALLELES_IN_FIRST_RUN);
  const inexactGenes = findGenesWithInexactResults(bestHits);
  if (inexactGenes.length > 0) {
    logger("cgps:debug:blast")("Running second round of blast");
    if (shouldRunCgMlst(taxidEnvVariables)) {
      bestHits = await runRound(
        20,
        80,
        inexactGenes,
        ALLELES_IN_FIRST_RUN,
        maxSeqs
      );
    } else {
      bestHits = await runRound(
        11,
        80,
        inexactGenes,
        ALLELES_IN_FIRST_RUN,
        maxSeqs
      );
    }
  }

  const output = formatOutput({ alleleMetadata, renamedSequences, bestHits });
  if (!taxidEnvVariables.DEBUG) {
    output.alleles = _.mapValues(output.alleles, hits =>
      _.map(hits, ({ id, contig, start, end }) => ({ id, contig, start, end }))
    )
  }
  return output;
}

module.exports = { runMlst };

if (require.main === module) {
  const taxidEnvVariables = {
    ...process.env,
    TAXID: argv.taxid || process.env.TAXID,
    ORGANISM_TAXID: argv.organism || process.env.ORGANISM_TAXID,
    SPECIES_TAXID: argv.species || process.env.SPECIES_TAXID,
    GENUS_TAXID: argv.genus || process.env.GENUS_TAXID,
  }
  if (argv.cgmlst) {
    taxidEnvVariables.RUN_CORE_GENOME_MLST = "yes"
  }
  runMlst(process.stdin, taxidEnvVariables)
    .then(output => console.log(JSON.stringify(output)))
    .then(() => logger("cgps:info")("Done"))
    .catch(fail("RunAllBlast"));
}
