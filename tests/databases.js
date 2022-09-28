const { test } = require("ava");
const Promise = require("bluebird");
const logger = require("debug");
const fs = require("fs");
const glob = require("glob");
const _ = require("lodash");
const zlib = require("zlib");
const { promisify } = require("util");
const path = require("path");

const { shouldRunCgMlst, getIndexDir } = require("../src/parseEnvVariables");

const globAsync = promisify(glob);
const gunzipAsync = promisify(zlib.gunzip);

async function readJson(p) {
  const zippedContents = await promisify(fs.readFile)(p);
  const contents = await gunzipAsync(zippedContents);
  return JSON.parse(contents);
}

test("MLST have profiles", async t => {
  if (shouldRunCgMlst()) {
    t.pass("Skipping for cgmlst");
    return;
  }
  const indexDir = getIndexDir();
  const metadataFiles = await globAsync(path.join(indexDir,
    "mlst_schemes/*/metadata.json.gz")
  );
  t.truthy(metadataFiles.length > 100, "Expected more metadata files");
  await Promise.map(
    metadataFiles,
    async f => {
      logger("cgps:test")(`Checking profiles for ${f}`);
      const { profiles } = await readJson(f);
      const nProfiles = _.keys(profiles).length;
      t.truthy(nProfiles > 1, `Expected more than one profile for ${f}`);
    },
    { concurrency: 1 }
  );
});
