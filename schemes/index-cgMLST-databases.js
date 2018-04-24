const _ = require("lodash");
const path = require("path");

const {
  BigsDbSchemes,
  RidomSchemes,
  EnterobaseSchemes,
  CgMlstMetadata
} = require("../src/mlst-database");
const { fail } = require("../src/utils");

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const DATA_DIR = "/opt/mlst/databases";

async function updateAllSchemes() {
  await new BigsDbSchemes(
    DATA_DIR,
    path.join(__dirname, "pasteur-schemes.json")
  ).update();
  await new BigsDbSchemes(
    DATA_DIR,
    path.join(__dirname, "pubmlst-schemes.json")
  ).update();
  await new RidomSchemes(DATA_DIR).update();
  await new EnterobaseSchemes(DATA_DIR).update();

  const schemesMetadata = await new CgMlstMetadata(DATA_DIR).allMetadata();
  const schemesUpdated = _.values(schemesMetadata);
  const schemeString = _(schemesUpdated)
    .map(({ description }) => `* ${description}`)
    .join("\n");
  console.log(`\nUpdated the following cgMLST schemes:\n${schemeString}`);
}

updateAllSchemes().catch(fail("Problem updating the metadata"));
