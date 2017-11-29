const _ = require("lodash");

const { BigsDbSchemes, RidomSchemes, EnterobaseSchemes } = require("./src/mlst-database");
const { warn } = require("./src/utils");

const DATA_DIR = "/opt/mlst/databases";

async function updateAllSchemes() {
  const bigsDbMetadata = await new BigsDbSchemes(DATA_DIR).update();
  const ridomMetadata = await new RidomSchemes(DATA_DIR).update();
  const enterobaseMetadata = await new EnterobaseSchemes(DATA_DIR).update();
  const schemesUpdated = _.concat(
    _.values(bigsDbMetadata),
    _.values(ridomMetadata),
    _.values(enterobaseMetadata)
  );
  const schemeString = _(schemesUpdated)
    .map(({ description }) => `* ${description}`)
    .join("\n");
  console.log(`\nUpdated the following cgMLST schemes:\n${schemeString}`);
}

updateAllSchemes().catch(warn("Problem updating the metadata"));
