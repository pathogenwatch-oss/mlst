const _ = require("lodash");
const fs = require("fs");
const logger = require("debug");
const path = require("path");

const { DeferredPromise } = require("./src/utils");
const { PubMlst } = require("./src/mlst-database");
const {
  buildTaxidSpeciesMap,
  TAXDUMP_HOST,
  TAXDUMP_REMOTE_PATH
} = require("./src/ncbi-taxid-lookup");

const DATA_DIR = "/opt/mlst/databases";

function matchTaxidsAndMlstSpecies(mlstMetadata, taxIdSpeciesMap) {
  const lookup = {};
  const mlstSpecies = _.keys(mlstMetadata);
  _.forIn(taxIdSpeciesMap, (species, taxid) => {
    if (mlstSpecies.includes(species)) {
      lookup[taxid] = species;
      logger("trace:match:matched")(species);
      return;
    }

    const genusScheme = `${species} spp.`;
    if (mlstSpecies.includes(genusScheme)) {
      lookup[taxid] = genusScheme;
      logger("trace:match:genus")(genusScheme);
      return;
    }
  });
  return lookup;
}

function writeMap(taxIdsSpeciesMap, outPath) {
  const output = new DeferredPromise();
  const payload = JSON.stringify(taxIdsSpeciesMap);
  fs.writeFile(outPath, payload, err => {
    if (err) output.reject(err);
    logger("debug:write")(`Wrote map to '${outPath}'`);
    output.resolve(taxIdsSpeciesMap);
  });
  return output;
}

const metadata = new PubMlst(DATA_DIR);
console.log(`Using ${metadata.PUBMLST_URL} to update ${metadata.dataDir}`);
const whenMetadataUpdated = metadata
  .update()
  .then(data => {
    const speciesString = _(data)
      .keys()
      .map(species => `* ${species}`)
      .value()
      .join("\n");
    console.log(`\nUpdated the following species:\n${speciesString}`);
    return data;
  })
  .catch(logger("error"));

const whenBuiltTaxIdSpeciesMap = buildTaxidSpeciesMap(
  TAXDUMP_HOST,
  TAXDUMP_REMOTE_PATH
);

whenBuiltTaxIdSpeciesMap
  .then(taxIdSpeciesMap => {
    const output = new DeferredPromise();
    const payload = JSON.stringify(taxIdSpeciesMap);
    const outPath = path.join(DATA_DIR, "allTaxIds.json");
    fs.writeFile(outPath, payload, err => {
      if (err) output.reject(err);
      output.resolve(outPath);
    });
    return output;
  })
  .then(logger("debug:allTaxIds"))
  .catch(logger("error"));

const whenMatchedTaxIdsToMlstSpecies = Promise.all([
  whenMetadataUpdated,
  whenBuiltTaxIdSpeciesMap
])
  .then(([mlstMetadata, taxIdSpeciesMap]) =>
    matchTaxidsAndMlstSpecies(mlstMetadata, taxIdSpeciesMap)
  )
  .then(matchedTaxIds => {
    const outPath = path.join(DATA_DIR, "taxIdSpeciesMap.json");
    writeMap(matchedTaxIds, outPath);
    return { outPath, matchedTaxIds };
  })
  .then(({ outPath, matchedTaxIds }) => {
    logger("info")(
      `Mapped ${_.keys(matchedTaxIds).length} ` +
        `taxids to MLST schemes in ${outPath}`
    );
    return matchedTaxIds;
  })
  .catch(logger("error"));

Promise.all([whenMetadataUpdated, whenMatchedTaxIdsToMlstSpecies])
  .then(([mlstMetadata, matchedTaxIds]) => {
    const matched = _.values(matchedTaxIds);
    const unmatched = _(mlstMetadata).keys().difference(matched).value();
    const unmatchedString = _.map(unmatched, species => `* ${species}`).join(
      "\n"
    );

    if (unmatched.length > 0) {
      logger("warning:unmatched")(
        "Could not find Taxids for " +
          `${unmatched.length} MLST schemes:\n${unmatchedString}`
      );
    }
  })
  .catch(logger("error"));
