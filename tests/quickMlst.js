const { test } = require("ava");
const path = require("path");
const Promise = require("bluebird");
const _ = require("lodash");
const fs = require("fs");

const { runMlst } = require("..");
const { shouldRunCgMlst } = require("../src/parseEnvVariables");

const { readJson, TESTDATA_DIR, compareAlleles } = require("../testUtils")

const staphDir = path.join(TESTDATA_DIR, "saureus_data");
const cgMlstCases = _.map(
  [
    "024_05",
    "Dog_150_N_G",
    "P1_1A",
  ], 
  name => {
    const seqPath = path.join(staphDir, `${name}.fasta`);
    const resultsPath = path.join(staphDir, `${name}.fasta.cgMlst.json`);
    return { name, seqPath, resultsPath, taxid: "1280" };
  }
)

const mlstCases = [
  { 
    name: "gono mlst",
    seqPath: path.join(TESTDATA_DIR, "gono.fasta"),
    resultsPath: path.join(TESTDATA_DIR, "gono.json"),
    taxid: "482"
  },
  {
    // This is not strictly speaking an MLST case but it is
    // very similar
    name: "gono ngstar",
    seqPath: path.join(TESTDATA_DIR, "gono.fasta"),
    resultsPath: path.join(TESTDATA_DIR, "gono.ngstar.json"),
    taxid: "485"
  }
]

test("Run a handfull of cases", async t => {
  if (process.env.QUICK !== "true") return t.pass("Skipped");
  const testCases = shouldRunCgMlst() ? cgMlstCases : mlstCases;
  const RUN_CORE_GENOME_MLST = shouldRunCgMlst() ? "yes" : "no"
  await Promise.map(
    testCases,
    async ({ name, seqPath, resultsPath, taxid }) => {
      const expectedResults = await readJson(resultsPath);
      const inputStream = fs.createReadStream(seqPath);
      const results = await runMlst(inputStream, {
        TAXID: taxid,
        RUN_CORE_GENOME_MLST
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

test("Check multiple copies of same allele", async t => {
  if (process.env.QUICK !== "true") return t.pass("Skipped");
  const seqPath = path.join(TESTDATA_DIR, "gono_fake.fasta");
  const inputStream = fs.createReadStream(seqPath);
  const results = await runMlst(inputStream, {
    TAXID: "482",
    RUN_CORE_GENOME_MLST: "no"
  });
  const expected = {
    code: "1_3_1_1_1_1_3,3,3",
    st: "1"
  }
  t.is(results.code, expected.code, `code: ${results.code} !== ${expected.code}`)
  t.is(results.st, expected.st, `st: ${results.st} !== ${expected.st}`)      
})

