#!/usr/bin/env node

const fs = require('fs');
const readline = require('readline');
const _ = require('lodash');
const logger = require('debug');

const taxDumpPath = 'taxdump/names.dmp';
const schemeSpeciesMapFile = 'db/scheme_species_map.tab'

// This builds a CSV file which maps taxonomy ids (taxIds) to
// their scientific name (species) and MLST scheme.  
//
// The taxonomy dump comes from NCBI and maps TaxIds to species:
// ftp://ftp.ncbi.nih.gov/pub/taxonomy/taxdump.tar.gz
//
// The MLST scheme lookup comes from:
// https://github.com/tseemann/mlst/blob/7c182ae4b68bfd4f97e1858998bffa14d01dc46b/db/scheme_species_map.tab

function getTaxIdSpeciesMap(path) {
  logger('info:getTaxIdSpeciesMap')(`Looking for scientific names in ${path}`)
  const inputFile = fs.createReadStream(path);
  const lineReader = readline.createInterface({
    input: inputFile
  })
  const taxIdSpeciesMap = [];

  lineReader.on('line', line => {
    const row = _(line).split('|').map(_.trim).value();
    const [taxid, species, tmp, rowType] = row.slice(0,4);
    if (rowType === 'scientific name') {
      taxIdSpeciesMap.push([taxid, species]);
    }
  });

  return new Promise((resolve, reject) => {
    lineReader.on('close', () => {
      logger('info:getTaxIdSpeciesMap')(`Found ${taxIdSpeciesMap.length} scientific names in ${taxDumpPath}`);
      resolve(taxIdSpeciesMap)
    });
  });
}

function mapTaxIdToSpecies(taxIdSpeciesList) {
  return new Promise((resolve, reject) => {
    logger('info:mapTaxIdToSpecies')(`Looking for duplicates among ${taxIdSpeciesList.length} species`)
    var errors = false;
    const taxIdsMap = _.reduce(taxIdSpeciesList, (results, [taxId, species]) => {
      if (results[taxId]) {
        errors = true;
        reject(`TaxId ${taxId} already used for ${results[taxId]}`)
      }
      results[taxId] = species;
      return results;
    }, {});

    resolve(taxIdsMap);
  });
}

function getSpeciesSchemeMap(path) {
  logger('info:getSpeciesSchemeMap')(`Looking for scheme names in ${path}`)
  const inputFile = fs.createReadStream(path);
  const lineReader = readline.createInterface({
    input: inputFile
  })
  const speciesSchemeMap = [];

  lineReader.on('line', line => {
    if (line[0] === '#') return
    const row = _(line).split('\t').map(_.trim).value();
    const [scheme, genus, species] = row;
    if (scheme === 'SCHEME') return
    speciesSchemeMap.push([_.trim(`${genus} ${species || ''}`), scheme]);
  });

  return new Promise((resolve, reject) => {
    lineReader.on('close', () => {
      logger('info:getSpeciesSchemeMap')(`Found ${speciesSchemeMap.length} schemes in ${taxDumpPath}`);
      resolve(speciesSchemeMap)
    });
  });
}

function mapSpeciesToScheme(speciesSchemeList) {
  return new Promise((resolve, reject) => {
    logger('info:mapSpeciesToScheme')(`Looking for duplicates among ${speciesSchemeList.length} species`)
    var errors = false;
    const speciesSchemeMap = _.reduce(speciesSchemeList, (results, [species, scheme]) => {
      if (results[species]) {
        errors = true;
        reject(`${species} already maps to ${results[species]}`)
      }
      results[species] = scheme;
      return results;
    }, {});

    resolve(speciesSchemeMap);
  });
}

function mapTaxIdToScheme(taxIdSpeciesMap, speciesSchemeMap) {
  logger('info:mapTaxIdToScheme')("Mapping taxIds to schemes");
  return new Promise((resolve, reject) => {
    const mapping = [];
    _.forEach(taxIdSpeciesMap, (species, taxId) => {
      scheme = speciesSchemeMap[species];
      if (scheme) {
        mapping.push([taxId, scheme, species]);
      }
    });
    resolve(mapping);
  });
}

function printTaxIdschemeMap(taxIdschemeMap) {
  logger('info:printTaxIdschemeMap')("Printing the results");
  const sorted = _.sortBy(taxIdschemeMap, [([taxId, scheme, species]) => { return parseInt(taxId) }]);
  _.forEach(sorted, row => {
    console.log(row.join(","));
  });
}

const mappings = [
  getTaxIdSpeciesMap(taxDumpPath).then(mapTaxIdToSpecies).catch(logger("error:TaxIdSpeciesMapping")),
  getSpeciesSchemeMap(schemeSpeciesMapFile).then(mapSpeciesToScheme).catch(logger("error:SpeciesSchemeMapping")),
]

Promise.all(mappings)
  .then((maps) => mapTaxIdToScheme(...maps))
  .then(printTaxIdschemeMap)
  .catch(logger("error:TaxIdSchemeMapping"));
