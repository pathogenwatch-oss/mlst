'use strict';

const _ = require('lodash');
const fs = require('fs');
const logger = require('debug');
const path = require('path');

const { DeferredPromise } = require('./utils');
const { PubMlst } = require('./mlst-database');
const { buildTaxidSpeciesMap, TAXDUMP_HOST, TAXDUMP_REMOTE_PATH } = require('./ncbi-taxid-lookup');

const DATA_DIR='/tmp/pubmlst'

function matchTaxidsAndMlstSpecies(mlstMetadata, taxIdSpeciesMap) {
  const lookup = {}
  const hardCodedSynonyms = {
    90370: "Salmonella enterica", // Typhi
  }
  const mlstSpecies = _.keys(mlstMetadata);
  _.forIn(taxIdSpeciesMap, (species, taxid) => {
    const hardCodedMlstSpecies = hardCodedSynonyms[Number(taxid)]
    if (hardCodedMlstSpecies) {
      lookup[taxid] = {species, mlstSpecies: hardCodedMlstSpecies}
      logger('trace:match:hardCoded')({species, hardCodedMlstSpecies})
      return
    }

    if (mlstSpecies.includes(species)) {
      lookup[taxid] = {species, mlstSpecies: species};
      logger('trace:match:matched')({species})
      return
    }

    const genus = species.split(' ')[0];
    const genusScheme = `${genus} spp.`
    if (mlstSpecies.includes(genusScheme)) {
      lookup[taxid] = {species, mlstSpecies: genusScheme};
      logger('trace:match:genus')({species, genusScheme})
      return
    }
  })
  return lookup;
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

const matchedTaxids = Promise.all([metadataUpdate, taxIdSpeciesMap])
  .then(([mlstMetadata, taxIdSpeciesMap]) => {
    return matchTaxidsAndMlstSpecies(mlstMetadata, taxIdSpeciesMap)
  })
  .then(matchedTaxids => {
    const outPath = path.join(DATA_DIR, 'taxIdSpeciesMap.json');
    writeMap(matchedTaxids, outPath);
    return {outPath, matchedTaxids}
  })
  .then(({outPath, matchedTaxids}) => {
    logger('info')(`Mapped ${_.keys(matchedTaxids).length} taxids to MLST schemes in ${outPath}`)
    return matchedTaxids;
  })
  .catch(logger('error'))

Promise.all([metadataUpdate, matchedTaxids])
  .then(([mlstMetadata, matchedTaxids]) => {
    const output = new DeferredPromise();
    const payload = JSON.stringify({mlstMetadata, matchedTaxids})
    fs.writeFile('/tmp/tmp.json', payload, (err, data) => {
      if (err) output.reject(err)
      output.resolve([mlstMetadata, matchedTaxids])
    })
    return output
  })
  .then(([mlstMetadata, matchedTaxids]) => {
    const matched = _(matchedTaxids)
      .values()
      .map(({mlstSpecies}) => mlstSpecies)
      .value()
    const unmatched = _(mlstMetadata)
      .keys()
      .difference(matched)
      .value()
    const unmatchedString = _.map(unmatched, species => `* ${species}`)
      .join('\n')

    if (unmatched.length > 0) {
      logger('warning:unmatched')(`Couldn't find Taxids for ${unmatched.length} MLST schemes:\n${unmatchedString}`)
    }
  })
  .catch(logger('error'))
