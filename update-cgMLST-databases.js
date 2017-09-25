const _ = require("lodash");
const logger = require("debug");

const { BigsDbSchemes } = require("./src/mlst-database");
const { fail } = require("./src/utils");

const DATA_DIR = "/opt/mlst/databases";

const CgMlstMetadata = new BigsDbSchemes(DATA_DIR);
CgMlstMetadata.update()
  .then(data => {
    const schemeNameString = _(data)
      .values()
      .map(scheme => `* ${scheme.name} (${scheme.description})`)
      .value()
      .join("\n");
    console.log(`\nUpdated the following cgMLST schemes:\n${schemeNameString}`);
    return data;
  })
  .catch(fail("Problem updating the metadata"));
