const { test } = require("ava");
const path = require("path");
const Promise = require("bluebird");
const _ = require("lodash");
const fs = require("fs");

const { runMlst } = require("..");
const { shouldRunCgMlst } = require("../src/parseEnvVariables");

const { readJson, TESTDATA_DIR, compareAlleles } = require("./utils")

test("Run a handfull of CgMLST cases", async t => {
  if (!shouldRunCgMlst()) {
    t.pass("Skipped");
    return;
  }

  const cases = [
    "024_05",
    "Dog_150_N_G",
    "P1_1A",
  ]
  
  const staphDir = path.join(TESTDATA_DIR, "saureus_data");
  
  const testCases = _.map(cases, name => {
    const seqPath = path.join(staphDir, `${name}.fasta`);
    const resultsPath = path.join(staphDir, `${name}.fasta.cgMlst.json`);
    return { name, seqPath, resultsPath };
  })

  await Promise.map(
    testCases,
    async ({ name, seqPath, resultsPath }) => {
      const expectedResults = await readJson(resultsPath);
      const inputStream = fs.createReadStream(seqPath);
      const results = await runMlst(inputStream, {
        WGSA_SPECIES_TAXID: "1280",
        RUN_CORE_GENOME_MLST: "yes"
      });
      t.deepEqual(
        compareAlleles(results, expectedResults),
        {},
        `${name}: alleles`
      );
      t.is(results.code, expectedResults.code, `${name}: code`);
      t.deepEqual(results.genes, expectedResults.genes, `${name}: genes`);
      t.is(results.st, expectedResults.st, `${name}: st`);
    },
    { concurrency: 1 }
  );
});