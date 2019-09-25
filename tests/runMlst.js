const { test } = require("ava");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const Promise = require("bluebird");
const _ = require("lodash");
const logger = require("debug");

const { runMlst } = require("..");
const { shouldRunCgMlst } = require("../src/parseEnvVariables");
const { readJson, TESTDATA_DIR, compareAlleles } = require("./utils")

test("compare alleles", t => {
  const testCases = [
    {
      actualAlleles: { geneA: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }] },
      pass: true
    },
    {
      actualAlleles: { geneA: [{ id: 1 }], geneB: [] },
      expectedAlleles: { geneA: [{ id: 1 }] },
      pass: true
    },
    {
      actualAlleles: { geneA: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }], geneB: [] },
      pass: true
    },
    {
      actualAlleles: { geneA: [{ id: 1 }, { id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }, { id: 1 }] },
      pass: true
    },
    {
      actualAlleles: { geneA: [{ id: 1 }], geneB: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }], geneB: [{ id: 1 }] },
      pass: true
    },
    {
      actualAlleles: { geneA: [{ id: 1 }], geneB: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }] },
      pass: false
    },
    {
      actualAlleles: { geneA: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }], geneB: [{ id: 1 }] },
      pass: false
    },
    {
      actualAlleles: { geneA: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }, { id: 1 }] },
      pass: false
    },
    {
      actualAlleles: { geneA: [{ id: 1 }, { id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }] },
      pass: false
    },
    {
      actualAlleles: { geneA: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 2 }] },
      pass: false
    },
    {
      actualAlleles: { geneA: [{ id: 1 }], geneC: [{ id: 1 }] },
      expectedAlleles: { geneA: [{ id: 1 }] },
      pass: true
    }
  ];
  _.forEach(testCases, ({ actualAlleles, expectedAlleles, pass }, i) => {
    const genes = ["geneA", "geneB"];
    const actual = { alleles: actualAlleles, genes };
    const expected = { alleles: expectedAlleles, genes };
    const badAlleles = compareAlleles(actual, expected);
    if (pass) {
      t.deepEqual(badAlleles, {}, i);
    } else {
      t.notDeepEqual(badAlleles, {}, i);
    }
  });
});

test("Run specific MLST cases", async t => {
  if (shouldRunCgMlst()) {
    t.pass("Skipped");
    return;
  }
  const testCases = [
    {
      name: "saureus_synthetic_ones",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_ones_duplicate",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_ones_duplicate_different_novel",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_ones_duplicate_identical_novel",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_ones_duplicate_one_novel",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_last",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_last_duplicate",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_last_duplicate_different_novel",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_last_duplicate_identical_novel",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_last_duplicate_one_novel",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_novel_reversed_duplicates",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_synthetic_ones_reversed",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_duplicate",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_missing",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_novel",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "saureus_bad_names",
      env: { WGSA_SPECIES_TAXID: "1280" }
    },
    {
      name: "gono",
      env: { WGSA_GENUS_TAXID: "482" }
    },
    {
      name: "shaemolyticus",
      env: { WGSA_SPECIES_TAXID: "1283" }
    },
    {
      name: "typhi",
      env: { WGSA_SPECIES_TAXID: "28901" }
    },
    {
      name: "typhi2",
      env: { WGSA_SPECIES_TAXID: "28901" }
    }
  ];
  await Promise.map(
    testCases,
    async ({ name, env }) => {
      logger("cgps:test")(`Running MLST for ${name}`);

      const expectedResults = await readJson(
        path.join(TESTDATA_DIR, `${name}.json`)
      );
      const inputStream = fs.createReadStream(
        path.join(TESTDATA_DIR, `${name}.fasta`)
      );

      const results = await runMlst(inputStream, env);
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

test("Run more staph MLST cases", async t => {
  if (shouldRunCgMlst()) {
    t.pass("Skipped");
    return;
  }

  const staphDir = path.join(TESTDATA_DIR, "saureus_data");
  const contents = await promisify(fs.readdir)(staphDir);
  const testCases = _(contents)
    .map(f => {
      if (!f.endsWith(".mlst.json")) {
        return null;
      }
      const name = f.replace(".mlst.json", "");
      const seqPath = path.join(staphDir, name);
      const resultsPath = path.join(staphDir, f);
      return { name, seqPath, resultsPath };
    })
    .filter(r => r !== null)
    .value();

  await Promise.map(
    testCases,
    async ({ name, seqPath, resultsPath }) => {
      const expectedResults = await readJson(resultsPath);
      const inputStream = fs.createReadStream(seqPath);
      const results = await runMlst(inputStream, {
        WGSA_SPECIES_TAXID: "1280"
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

test("Run synthetic CgMLST", async t => {
  if (!shouldRunCgMlst()) {
    t.pass("Skipped");
    return;
  }

  const name = "saureus_synthetic_cg";

  const expectedResults = await readJson(
    path.join(TESTDATA_DIR, `${name}.fasta.cgMlst.json`)
  );
  const inputStream = fs.createReadStream(
    path.join(TESTDATA_DIR, `${name}.fasta`)
  );

  const results = await runMlst(inputStream, {
    WGSA_SPECIES_TAXID: "1280",
    RUN_CORE_GENOME_MLST: "yes"
  });
  t.deepEqual(compareAlleles(results, expectedResults), {}, `${name}: alleles`);
  t.is(results.code, expectedResults.code, `${name}: code`);
  t.deepEqual(results.genes, expectedResults.genes, `${name}: genes`);
  t.is(results.st, expectedResults.st, `${name}: st`);
});

test("Run more staph CgMLST cases", async t => {
  if (!shouldRunCgMlst()) {
    t.pass("Skipped");
    return;
  }

  const staphDir = path.join(TESTDATA_DIR, "saureus_data");
  const contents = await promisify(fs.readdir)(staphDir);
  const testCases = _(contents)
    .map(f => {
      if (!f.endsWith(".cgMlst.json")) {
        return null;
      }
      const name = f.replace(".cgMlst.json", "");
      const seqPath = path.join(staphDir, name);
      const resultsPath = path.join(staphDir, f);
      return { name, seqPath, resultsPath };
    })
    .filter(r => r !== null)
    .value();

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
