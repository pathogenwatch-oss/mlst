#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const _ = require('lodash');
const logger = require('debug');
const path = require('path');

const { PubMlst } = require('./mlst-database')
const { makeBlastDb, BlastHitsStore } = require('./blast')
const {
  getAlleleStreams, addHashesToHits, addMatchingAllelesToHits,
  startBlast, processBlastResultsStream, stopBlast, buildResults
} = require('./mlst')

const DATA_DIR = '/tmp/pubmlst';

const [ TAXID, SAMPLE ] = process.argv.slice(2);

const taxIdLookupData = require(path.join(DATA_DIR, 'taxIdSpeciesMap.json'))
const species = (taxIdLookupData[TAXID] || {}).mlstSpecies

logger('params')({ TAXID, SAMPLE, species })

if (typeof(species) == 'undefined') {
  console.log(JSON.stringify({error: `Could not find MLST scheme for ${TAXID}`}))
  process.exit(1);
}

const alleleMetadata = new PubMlst(DATA_DIR).read(species);
const alleleHashes = alleleMetadata['hashes'];
const alleleLengths = alleleMetadata['lengths'];
const { genes, profiles, allelePaths, scheme, commonGeneLengths } = alleleMetadata;

const NUMBER_OF_ALLELES=5;
const alleleStreams = getAlleleStreams(allelePaths, NUMBER_OF_ALLELES)

const blastDb = makeBlastDb(SAMPLE);
const hits = new BlastHitsStore(alleleLengths);

const firstStreams = _.values(alleleStreams);

const firstRunStart = Promise.all([firstStreams, blastDb])
  .then(([streams, db]) => {
    return { streams, db, wordSize: 30, pIdent: 80 }
  })
  .then(startBlast)

const firstRunProcessing = Promise.all([firstStreams, firstRunStart])
  .then(([streams, { blast, blastResultsStream }]) => {
    return { hits, streams, blast, blastResultsStream };
  })
  .then(processBlastResultsStream)

const firstRunStop = Promise.all([firstRunStart, firstRunProcessing])
  .then(([{ blast, blastInputStream }, _tmp]) => {
    return { blast, blastInputStream }
  })
  .then(stopBlast)

const firstResults = firstRunStop
  .then(() => {
    return hits.best()
  })
  .then(bestHits => {
    return addHashesToHits(SAMPLE, bestHits)
  })
  .then(bestHits => {
    addMatchingAllelesToHits(alleleHashes, bestHits)
    return bestHits
  }).then(bestHits => {
    return { bestHits, alleleLengths, genes, profiles, scheme, commonGeneLengths }
  })
  .then(buildResults)
  .catch(logger('error'))

firstResults
  .then(logger('hits:first'))

const secondStreams = Promise.all([alleleStreams, firstResults])
  .then(([streamsMap, results]) => {
    const perfectResultFilter = ([gene, [firstMatch, ...otherMatches]]) => {
      const perfect = (firstMatch && firstMatch.perfect && otherMatches.length == 0);
      return !perfect;
    }
    const imperfectGenes = _(results.raw)
      .toPairs()
      .filter(perfectResultFilter)
      .map(([gene, matches]) => { return gene })
      .value()
    const imperfectStreams = _.map(imperfectGenes, gene => {
      const stream = streamsMap[gene];
      logger('debug')(`Blasting more alleles of ${gene}`)
      stream.updateLimit(50);
      return stream
    });
    return imperfectStreams
  })
  .catch(logger('error'))

const secondRunStart = Promise.all([secondStreams, blastDb])
  .then(([streams, db]) => {
    return { streams, db, wordSize: 20, pIdent: 80 }
  })
  .then(startBlast)
  .catch(logger('error'))

const secondRunProcessing = Promise.all([secondStreams, secondRunStart])
  .then(([streams, { blast, blastResultsStream }]) => {
    return { hits, streams, blast, blastResultsStream };
  })
  .then(processBlastResultsStream)
  .catch(logger('error'))

const secondRunStop = Promise.all([secondRunStart, secondRunProcessing])
  .then(([{ blast, blastInputStream }, _tmp]) => {
    return { blast, blastInputStream }
  })
  .then(stopBlast)
  .catch(logger('error'))

const secondResults = secondRunStop
  .then(() => {
    return hits.best()
  })
  .then(bestHits => {
    return addHashesToHits(SAMPLE, bestHits)
  })
  .then(bestHits => {
    addMatchingAllelesToHits(alleleHashes, bestHits)
    return bestHits
  }).then(bestHits => {
    return { bestHits, alleleLengths, genes, profiles, scheme, commonGeneLengths }
  })
  .then(buildResults)
  .catch(logger('error'))

secondResults
  .then(logger('hits:second'))

const thirdStreams = Promise.all([alleleStreams, secondResults])
  .then(([streamsMap, results]) => {
    const perfectResultFilter = ([gene, [firstMatch, ...otherMatches]]) => {
      const perfect = (firstMatch && firstMatch.perfect && otherMatches.length == 0);
      return !perfect;
    }
    const imperfectGenes = _(results.raw)
      .toPairs()
      .filter(perfectResultFilter)
      .map(([gene, matches]) => { return gene })
      .value()
    const imperfectStreams = _.map(imperfectGenes, gene => {
      const stream = streamsMap[gene];
      logger('debug')(`Blasting remaining alleles of ${gene}`)
      stream.updateLimit(null);
      return stream
    });
    return imperfectStreams
  })
  .catch(logger('error'))

const thirdRunStart = Promise.all([thirdStreams, blastDb])
  .then(([streams, db]) => {
    return { streams, db, wordSize: 11, pIdent: 0 }
  })
  .then(startBlast)
  .catch(logger('error'))

const thirdRunProcessing = Promise.all([thirdStreams, thirdRunStart])
  .then(([streams, { blast, blastResultsStream }]) => {
    return { hits, streams, blast, blastResultsStream };
  })
  .then(processBlastResultsStream)
  .catch(logger('error'))

const thirdRunStop = Promise.all([thirdRunStart, thirdRunProcessing])
  .then(([{ blast, blastInputStream }, _tmp]) => {
    return { blast, blastInputStream }
  })
  .then(stopBlast)
  .catch(logger('error'))

const thirdResults = thirdRunStop
  .then(() => {
    return hits.best()
  })
  .then(bestHits => {
    return addHashesToHits(SAMPLE, bestHits)
  })
  .then(bestHits => {
    addMatchingAllelesToHits(alleleHashes, bestHits)
    return bestHits
  }).then(bestHits => {
    return { bestHits, alleleLengths, genes, profiles, scheme, commonGeneLengths }
  })
  .then(buildResults)
  .catch(logger('error'))

thirdResults
  .then(logger('hits:third'))

thirdResults
  .then(JSON.stringify)
  .then(console.log)
