'use strict';

const _ = require('lodash');
const fs = require('fs');
const logger = require('debug');
const path = require('path');

const { DeferredPromise } = require('./utils');
const { PubMlst } = require('./mlst-database');
const { buildTaxidSpeciesMap, TAXDUMP_HOST, TAXDUMP_REMOTE_PATH } = require('./ncbi-taxid-lookup');

const DATA_DIR='/tmp/pubmlst'

function fuzzyMatchTaxidsAndMlstSpecies(taxIdsSpeciesMap, mlstMetadata) {
  const mappedData = {};
  const mlstSpecies = _.keys(mlstMetadata);

  const matchingFunctions = [
    species => species,
    species => species.replace(/ sp\.?$/, ' spp.'),
    // species => species + ' spp',
    // species => species + ' sp',
    // species => species + ' spp.',
    // species => species + ' sp.',
  ]

  var unmatched = 0;
  _(taxIdsSpeciesMap)
    .toPairs()
    .forEach(([taxId, species]) => {
      _.forEach(matchingFunctions, fn => {
        const reformattedSpeciesName = fn(species);
        if (mlstSpecies.includes(reformattedSpeciesName)) {
          mappedData[taxId] = reformattedSpeciesName;
          if (species == reformattedSpeciesName) {
            logger('trace:matched')({species})
          } else {
            logger('trace:fuzzyMatched')({species, reformattedSpeciesName})
          }
          return false;
        }
      })
    })
  return mappedData;
}

function writeMap(taxIdsSpeciesMap, outPath) {
  const output = new DeferredPromise();
  const payload = JSON.stringify(taxIdsSpeciesMap);
  fs.writeFile(outPath, payload, (err) => {
    if (err) output.reject(err)
    logger('debug:write')(`Wrote map to '${outPath}'`)
    output.resolve(taxIdsSpeciesMap);
  })
  return output
}

const metadata = new PubMlst(DATA_DIR);
console.log(`Using ${metadata.PUBMLST_URL} to update ${metadata.dataDir}`)
const metadataUpdate = metadata.update()
  .then(data => {
    const speciesString = _(data)
      .keys()
      .map(species => `* ${species}`)
      .value()
      .join('\n')
    console.log(`\nUpdated the following species:\n${speciesString}`)
    return data
  })
  .catch(logger('error'))

const taxIdSpeciesMap = buildTaxidSpeciesMap(TAXDUMP_HOST, TAXDUMP_REMOTE_PATH);

const fuzzyMatchedTaxids = Promise.all([metadataUpdate, taxIdSpeciesMap])
  .then(([mlstMetadata, taxIdSpeciesMap]) => {
    return fuzzyMatchTaxidsAndMlstSpecies(taxIdSpeciesMap, mlstMetadata)
  })
  .then(fuzzyMatchedTaxids => {
    const outPath = path.join(DATA_DIR, 'taxIdSpeciesMap.json');
    writeMap(fuzzyMatchedTaxids, outPath);
    return {outPath, fuzzyMatchedTaxids}
  })
  .then(({outPath, fuzzyMatchedTaxids}) => {
    logger('info')(`Mapped ${_.keys(fuzzyMatchedTaxids).length} taxids to MLST schemes in ${outPath}`)
    return fuzzyMatchedTaxids;
  })
  .catch(logger('error'))

Promise.all([metadataUpdate, fuzzyMatchedTaxids])
  .then(([mlstMetadata, fuzzyMatchedTaxids]) => {
    const unmatched = _(mlstMetadata)
      .keys()
      .filter(species => !_.values(fuzzyMatchedTaxids).includes(species))
      .value()
    const unmatchedString = _.map(unmatched, species => `* ${species}`)
      .join('\n')

    if (unmatched.length > 0) {
      logger('warning:unmatched')(`Couldn't find Taxids for ${unmatched.length} MLST schemes:\n${unmatchedString}`)
    }
  })
  .catch(logger('error'))
