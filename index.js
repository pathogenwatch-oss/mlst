#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const _ = require('lodash');
const logger = require('debug');
const path = require('path');

const { PubMlst } = require('./src/mlst-database')
const { makeBlastDb, BlastHitsStore } = require('./src/blast')
const {
  getAlleleStreams, addHashesToHits, addMatchingAllelesToHits,
  startBlast, processBlastResultsStream, stopBlast, buildResults
} = require('./src/mlst')

const DATA_DIR = '/opt/mlst/databases';

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

const {whenContigNameMap, whenBlastDb} = makeBlastDb(SAMPLE);

const whenHitsStore = whenContigNameMap
  .then(contigNameMap => new BlastHitsStore(alleleLengths, contigNameMap));

const whenFirstRunStreams = _.values(alleleStreams);

const whenFirstRunStart = Promise.all([whenFirstRunStreams, whenBlastDb])
  .then(([streams, db]) => {
    return { streams, db, wordSize: 30, pIdent: 80 }
  })
  .then(startBlast)

const whenFirstRunProcessed = Promise.all([whenHitsStore, whenFirstRunStreams, whenFirstRunStart])
  .then(([hitsStore, streams, { blast, blastResultsStream }]) => {
    return { hitsStore, streams, blast, blastResultsStream };
  })
  .then(processBlastResultsStream)

const whenFirstRunStopped = Promise.all([whenFirstRunStart, whenFirstRunProcessed])
  .then(([{ blast, blastInputStream }, _tmp]) => {
    return { blast, blastInputStream }
  })
  .then(stopBlast)

const whenFirstRunResultCalculated = whenFirstRunStopped.then(() => whenHitsStore)
  .then(hitsStore => hitsStore.best())
  .then(bestHits => addHashesToHits(SAMPLE, bestHits))
  .then(bestHits => {
    addMatchingAllelesToHits(alleleHashes, bestHits)
    return bestHits
  }).then(bestHits => {
    return { bestHits, alleleLengths, genes, profiles, scheme, commonGeneLengths }
  })
  .then(buildResults)
  .catch(logger('error'))

whenFirstRunResultCalculated
  .then(logger('hits:first'))

function findGenesWithImperfectResults(results) {
  const perfectResultFilter = ([gene, [firstMatch, ...otherMatches]]) => {
    const perfect = (firstMatch && firstMatch.perfect && otherMatches.length == 0);
    return !perfect;
  }
  const imperfectGenes = _(results.raw)
    .toPairs()
    .filter(perfectResultFilter)
    .map(([gene, matches]) => gene)
    .value()
  return imperfectGenes
}

function getAlleleStreamsForGenes(genes) {
  return _.map(genes, gene => alleleStreams[gene])
}

function updateAlleleStreamLimits(streams, limit) {
  return _.map(streams, stream => {
    stream.updateLimit(limit);
    return stream
  })
}

const whenSecondRunStreams = whenFirstRunResultCalculated
  .then(findGenesWithImperfectResults)
  .then(getAlleleStreamsForGenes)
  .then(alleleStreamsWithoutPerfectResults =>
    updateAlleleStreamLimits(alleleStreamsWithoutPerfectResults, 50))
  .catch(logger('error'))

const whenSecondRunStart = Promise.all([whenSecondRunStreams, whenBlastDb])
  .then(([streams, db]) => {
    return { streams, db, wordSize: 20, pIdent: 80 }
  })
  .then(startBlast)
  .catch(logger('error'))

const whenSecondRunProcessed = Promise.all([whenHitsStore, whenSecondRunStreams, whenSecondRunStart])
  .then(([hitsStore, streams, { blast, blastResultsStream }]) => {
    return { hitsStore, streams, blast, blastResultsStream };
  })
  .then(processBlastResultsStream)
  .catch(logger('error'))

const whenSecondRunStopped = Promise.all([whenSecondRunStart, whenSecondRunProcessed])
  .then(([{ blast, blastInputStream }, _tmp]) => {
    return { blast, blastInputStream }
  })
  .then(stopBlast)
  .catch(logger('error'))

const whenSecondRunResultsCalculated = whenSecondRunStopped
  .then(() => whenHitsStore)
  .then(hitsStore => hitsStore.best())
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

whenSecondRunResultsCalculated
  .then(logger('hits:second'))

const whenThirdRunStreams = whenSecondRunResultsCalculated
  .then(findGenesWithImperfectResults)
  .then(getAlleleStreamsForGenes)
  .then(alleleStreamsWithoutPerfectResults =>
    updateAlleleStreamLimits(alleleStreamsWithoutPerfectResults, null))
  .catch(logger('error'))

const whenThirdRunStarted = Promise.all([whenThirdRunStreams, whenBlastDb])
  .then(([streams, db]) => {
    return { streams, db, wordSize: 11, pIdent: 0 }
  })
  .then(startBlast)
  .catch(logger('error'))

const whenThirdRunProcessed = Promise.all([whenHitsStore, whenThirdRunStreams, whenThirdRunStarted])
  .then(([hitsStore, streams, { blast, blastResultsStream }]) => {
    return { hitsStore, streams, blast, blastResultsStream };
  })
  .then(processBlastResultsStream)
  .catch(logger('error'))

const whenThirdRunStopped = Promise.all([whenThirdRunStarted, whenThirdRunProcessed])
  .then(([{ blast, blastInputStream }, _tmp]) => {
    return { blast, blastInputStream }
  })
  .then(stopBlast)
  .catch(logger('error'))

const whenThirdRunResultsCalculated = whenThirdRunStopped
  .then(() => whenHitsStore)
  .then(hitsStore => hitsStore.best())
  .then(bestHits => addHashesToHits(SAMPLE, bestHits))
  .then(bestHits => {
    addMatchingAllelesToHits(alleleHashes, bestHits)
    return bestHits
  }).then(bestHits => {
    return { bestHits, alleleLengths, genes, profiles, scheme, commonGeneLengths }
  })
  .then(buildResults)
  .catch(logger('error'))

whenThirdRunResultsCalculated
  .then(logger('hits:third'))

whenThirdRunResultsCalculated
  .then(JSON.stringify)
  .then(console.log)
