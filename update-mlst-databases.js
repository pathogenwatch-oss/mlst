const _ = require("lodash");
const logger = require("debug");

const { PubMlstSevenGenomeSchemes } = require("./src/mlst-database");
const {
  buildSpeciesTaxidMap,
  TAXDUMP_HOST,
  TAXDUMP_REMOTE_PATH
} = require("./src/ncbi-taxid-lookup");

const DATA_DIR = "/opt/mlst/databases";

const whenBuiltSpeciesTaxidsMap = buildSpeciesTaxidMap(
  TAXDUMP_HOST,
  TAXDUMP_REMOTE_PATH
);

const sevenGenomeMlstMetadata = new PubMlstSevenGenomeSchemes(DATA_DIR);

whenBuiltSpeciesTaxidsMap
  .then(speciesTaxids => sevenGenomeMlstMetadata.update(speciesTaxids))
  .then(data => {
    const speciesString = _(data)
      .values()
      .map(({ species }) => `* ${species}`)
      .value()
      .join("\n");
    console.log(`\nUpdated the following species:\n${speciesString}`);
    return data;
  })
  .catch(logger("error"));
