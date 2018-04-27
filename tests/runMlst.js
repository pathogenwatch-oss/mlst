const { test } = require("ava");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const Promise = require("bluebird");
const _ = require("lodash");
const logger = require("debug");

const { runMlst } = require("..");

async function readJson(p) {
  const contents = await promisify(fs.readFile)(p);
  return JSON.parse(contents);
}

const TESTDATA_DIR = path.join(__dirname, "testdata");

test("Run specific MLST cases", async t => {
  if (process.env.RUN_CORE_GENOME_MLST) {
    t.pass("Skipping MLST test");
    return;
  }

  const initialEnv = _.clone(process.env);

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
  await Promise.all(
    Promise.map(
      testCases,
      async ({ name, env }) => {
        const expectedResults = await readJson(
          path.join(TESTDATA_DIR, `${name}.json`)
        );
        const inputStream = fs.createReadStream(
          path.join(TESTDATA_DIR, `${name}.fasta`)
        );
        process.env = { ...initialEnv, ...env };

        const results = await runMlst(inputStream);
        t.is(results.st, expectedResults.st, `${name}: st`);
        t.is(results.code, expectedResults.code, `${name}: code`);
        t.deepEqual(
          results.alleles,
          expectedResults.alleles,
          `${name}: alleles`
        );
      },
      { concurrency: 1 }
    )
  );

  process.env = initialEnv;
});

test("Run more staph MLST cases", async t => {
  if (process.env.RUN_CORE_GENOME_MLST) {
    t.pass("Skipping MLST test");
    return;
  }

  const initialEnv = _.clone(process.env);
  process.env.WGSA_SPECIES_TAXID = "1280";

  const staphDir = path.join(TESTDATA_DIR, "saureus_data");
  const contents = await promisify(fs.readdir)(staphDir);
  const testCases = _(contents)
    .map(f => {
      if (!f.endsWith(".mlst.json")) {
        return null;
      }
      const name = f.replace(".mlst.json", "");
      const seqPath = path.join(staphDir, `${name}.fasta`);
      const resultsPath = path.join(staphDir, f);
      return { name, seqPath, resultsPath };
    })
    .filter(r => r !== null)
    .value();

  await Promise.all(
    Promise.map(
      testCases,
      async ({ name, seqPath, resultsPath }) => {
        const expectedResults = await readJson(resultsPath);
        const inputStream = fs.createReadStream(seqPath);
        const results = await runMlst(inputStream);
        t.is(results.st, expectedResults.st, `${name}: st`);
        t.is(results.code, expectedResults.code, `${name}: code`);
        t.deepEqual(
          results.alleles,
          expectedResults.alleles,
          `${name}: alleles`
        );
      },
      { concurrency: 1 }
    )
  );

  process.env = initialEnv;
});

test("Run synthetic CgMLST", async t => {
  const RUN_CORE_GENOME_MLST = process.env.RUN_CORE_GENOME_MLST;
  if (
    !RUN_CORE_GENOME_MLST ||
    ["y", "yes", "true", "1"].indexOf(RUN_CORE_GENOME_MLST.toLowerCase()) == -1
  ) {
    t.pass("Skipping CgMLST test");
    return;
  }

  const initialEnv = _.clone(process.env);
  process.env.WGSA_SPECIES_TAXID = "1280";

  const name = "saureus_synthetic_cg";

  const expectedResults = await readJson(
    path.join(TESTDATA_DIR, `${name}.fasta.cgMlst.json`)
  );
  const inputStream = fs.createReadStream(
    path.join(TESTDATA_DIR, `${name}.fasta`)
  );

  const results = await runMlst(inputStream);
  t.is(results.st, expectedResults.st, `${name}: st`);
  t.is(results.code, expectedResults.code, `${name}: code`);
  t.deepEqual(results.alleles, expectedResults.alleles, `${name}: alleles`);

  process.env = initialEnv;
});

test.only("Run more staph CgMLST cases", async t => {
  const RUN_CORE_GENOME_MLST = process.env.RUN_CORE_GENOME_MLST;
  if (
    !RUN_CORE_GENOME_MLST ||
    ["y", "yes", "true", "1"].indexOf(RUN_CORE_GENOME_MLST.toLowerCase()) == -1
  ) {
    t.pass("Skipping CgMLST test");
    return;
  }

  const initialEnv = _.clone(process.env);
  process.env.WGSA_SPECIES_TAXID = "1280";

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

  await Promise.all(
    Promise.map(
      testCases,
      async ({ name, seqPath, resultsPath }) => {
        const expectedResults = await readJson(resultsPath);
        const inputStream = fs.createReadStream(seqPath);
        const results = await runMlst(inputStream);
        t.is(results.st, expectedResults.st, `${name}: st`);
        t.is(results.code, expectedResults.code, `${name}: code`);
        t.deepEqual(
          results.alleles,
          expectedResults.alleles,
          `${name}: alleles`
        );
      },
      { concurrency: 1 }
    )
  );

  process.env = initialEnv;
});
