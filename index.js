#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const _ = require('lodash');
const logger = require('debug');
const path = require('path');

const { readMetadata } = require('./pubmlst')
const { makeBlastDb, BlastHitsStore } = require('./blast')
const {
  getAlleleStreams, addHashesToHits, addMatchingAllelesToHits,
  startBlast, processBlastResultsStream, stopBlast, filterResults
} = require('./mlst')

const SPECIES="Staphylococcus aureus"
const SAMPLE='/data/saureus_7hlohgcu9cho/MRSA_10C.fasta';

const alleleMetadata = readMetadata(SPECIES);
const alleleHashes = alleleMetadata['hashes'];
const alleleLengths = alleleMetadata['lengths'];

const NUMBER_OF_ALLELES=1;
const alleleStreams = getAlleleStreams(SPECIES, NUMBER_OF_ALLELES)

const blastDb = makeBlastDb(SAMPLE);
const hits = new BlastHitsStore(alleleLengths);

const firstStreams = alleleStreams
  .then(streamsMap => {
    return _.values(streamsMap)
  })

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
  })

firstResults
  .then(bestHits => {
    return { bestHits, alleleLengths }
  })
  .then(filterResults)
  .then(logger('hits:first'))
  .catch(logger('hits:error'))
