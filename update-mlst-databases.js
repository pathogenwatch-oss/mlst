const _ = require("lodash");

const { PubMlstSevenGenomeSchemes } = require("./src/mlst-database");
const { loadSpeciesTaxidMap } = require("./src/ncbi-taxid-lookup");
const { warn } = require("./src/utils");

const DATA_DIR = "/opt/mlst/databases";

const whenBuiltSpeciesTaxidsMap = loadSpeciesTaxidMap();

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
  .catch(warn("Problem updating the metadata"));
