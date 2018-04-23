const _ = require("lodash");

const { PubMlstSevenGenomeSchemes } = require("../src/mlst-database");
const { loadSpeciesTaxidMap } = require("../src/ncbi-taxid-lookup");
const { fail } = require("../src/utils");

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const DATA_DIR = "/opt/mlst/databases";

async function updateAllSchemes() {
  const speciesTaxids = await loadSpeciesTaxidMap();
  const sevenGenomeMlstMetadata = new PubMlstSevenGenomeSchemes(DATA_DIR);
  const updates = await sevenGenomeMlstMetadata.update(speciesTaxids);
  const speciesString = _(updates)
    .values()
    .map(({ species }) => `* ${species}`)
    .value()
    .join("\n");
  console.log(`\nUpdated the following species:\n${speciesString}`);
  return updates;
}

updateAllSchemes().catch(fail("Problem updating the metadata"));
