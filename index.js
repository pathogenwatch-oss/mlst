#!/usr/bin/env node

const _ = require("lodash");
const logger = require("debug");
const argv = require("yargs")
  .boolean('cgmlst')
  .argv

const { makeBlastDb } = require("./src/blast");
const {
  HitsStore,
  streamFactory,
  findGenesWithInexactResults,
  formatOutput,
  integrateHits
} = require("./src/mlst");
const { findExactHits } = require("./src/exactHits");
const { fail } = require("./src/utils");
const { getMetadataPath, shouldRunCgMlst } = require("./src/parseEnvVariables");
const { readSchemeDetails, getAlleleDbPath, DEFAULT_INDEX_DIR } = require("./src/mlst-database");
const { dirname } = require('path');
const { createReadStream } = require('fs');

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const ALLELES_IN_FIRST_RUN = 5;



async function runMlst(inStream, taxidEnvVariables) {
  const metadataPath = await getMetadataPath(taxidEnvVariables);
  const indexDir = !!taxidEnvVariables.INDEX_DIR ? taxidEnvVariables.INDEX_DIR : DEFAULT_INDEX_DIR;
  const alleleMetadata = await readSchemeDetails(metadataPath, indexDir);
  const alleleDbPath = getAlleleDbPath(dirname(metadataPath), indexDir );
  const alleleDb = require('better-sqlite3')(alleleDbPath, { readonly: true });

  const { contigNameMap, blastDb, renamedSequences } = await makeBlastDb(
    inStream
  );

  const exactHits = integrateHits(findExactHits(
    renamedSequences,
    alleleMetadata.alleleDictionary,
    alleleDb
  ));

  alleleDb.close();

  const {
    lengths: alleleLengths,
    genes,
    allelePaths,
    name: schemeName,
    maxSeqs = 0
  } = alleleMetadata;

  logger("cgps:debug")(`Scheme '${schemeName}' has ${genes.length} genes`);

  const streamBuilder = streamFactory(allelePaths);
  const hitsStore = new HitsStore(alleleLengths, contigNameMap);

  _.forEach(exactHits, hit => hitsStore.add(hit));
  logger("cgps:debug:exactHits")(
    `Added exact matches for ${new Set(_.uniq(_.map(exactHits, ({ gene }) => gene))).size} out of ${
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
  let bestHits = hitsStore.best();

  logger("cgps:debug:blast")("Running first round of blast");
  bestHits = await runRound(30, 80, genes, 0, ALLELES_IN_FIRST_RUN);
  const inexactGenes = findGenesWithInexactResults(bestHits)
  if (inexactGenes.length > 0) {
    logger("cgps:debug:blast")("Running second round of blast");
    if (shouldRunCgMlst(taxidEnvVariables)) {
      bestHits = await runRound(
        20,
        80,
        inexactGenes,
        0,
        maxSeqs
      );
    } else {
      bestHits = await runRound(
        11,
        80,
        inexactGenes,
        0,
        maxSeqs
      );
    }
  }

  // The above approach still allows exact matches from different loci/genes to significantly overlap where they are paralogs.
  // For Salmonella (and possibly other species) this means non-existent extra matches are called.
  const finalSelection = integrateHits(bestHits, exactHits);

  const output = formatOutput({ alleleMetadata, renamedSequences, bestHits: finalSelection });
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
    INDEX_DIR: argv.indexDir || process.env.INDEX_DIR,
  }
  if (argv.cgmlst) {
    taxidEnvVariables.RUN_CORE_GENOME_MLST = "yes"
  }
  // runMlst(createReadStream('/opt/project/tests/GCF_006165265.fasta'), taxidEnvVariables)
  runMlst(process.stdin, taxidEnvVariables)
    .then(output => console.log(JSON.stringify(output)))
    .then(() => logger("cgps:info")("Done"))
    .catch(fail("RunAllBlast"));
}
