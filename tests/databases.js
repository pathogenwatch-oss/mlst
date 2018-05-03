const { test } = require("ava");
const Promise = require("bluebird");
const logger = require("debug");
const fs = require("fs");
const glob = require("glob")
const _ = require("lodash");
const { promisify } = require("util")

const globAsync = promisify(glob);
async function readJson(p) {
  const contents = await promisify(fs.readFile)(p);
  return JSON.parse(contents);
}

test("Check genes are ordered", async t => {
  const metadataFiles = await globAsync("/opt/mlst/databases/**/metadata.json");
  t.truthy(metadataFiles.length > 100, "Expected more metadata files")
  await Promise.map(
    metadataFiles,
    async f => {
      logger("test")(`Checking gene order for ${f}`)
      const { genes } = await readJson(f);
      const unsorted = [ ...genes ];
      genes.sort()
      t.deepEqual(unsorted, genes, `Expected genes for ${f} to be sorted`)
    },
    { concurrency: 1 }
  )
})

test("MLST have profiles", async t => {
  const metadataFiles = await globAsync("/opt/mlst/databases/mlst_**/metadata.json");
  t.truthy(metadataFiles.length > 100, "Expected more metadata files")
  await Promise.map(
    metadataFiles,
    async f => {
      logger("test")(`Checking profiles for ${f}`)
      const { profiles } = await readJson(f);
      const nProfiles = _.keys(profiles).length;
      t.truthy(nProfiles > 1, `Expected more than one profile for ${f}`);
    },
    { concurrency: 1 }
  )
})