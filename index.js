#!/usr/bin/env node

'use strict';

const fasta = require('bionode-fasta');
const { spawn } = require('child_process');
const _ = require('lodash');
const readline = require('readline');
const logger = require('debug');
const path = require('path');
const hasha = require('hasha');

const { listAlleleFiles, readMetadata, FastaString } = require('./pubmlst')
const { ObjectTap } = require('./utils')
const { makeBlastDb, createBlastProcess, BlastHitsStore } = require('./blast')

const SPECIES="Staphylococcus aureus"
const SAMPLE='/data/saureus_7hlohgcu9cho/MRSA_10C.fasta';

const alleleMetadata = readMetadata(SPECIES);
const alleleHashes = alleleMetadata['hashes'];
const alleleLengths = alleleMetadata['lengths'];

const NUMBER_OF_ALLELES=10;

const makeBlastInputStream = () => {
  return new FastaString({
    highWaterMark: _.keys(alleleLengths).length + 10,
  })
}

function getAlleleStreams(species, limit) {
  return listAlleleFiles(species)
    .then(paths => {
      const streams = {};
      _.forEach(paths, p => {
        const allele = path.basename(p, '.tfa')
        const stream = fasta.obj(p).pipe(new ObjectTap({limit}));
        streams[allele] = stream;
      });
      return streams;
    })
}

const alleleStreams = getAlleleStreams(SPECIES, NUMBER_OF_ALLELES)

function addHashesToHits(fastaPath, hits) {
  logger('trace:hash')(`About to add hashes to ${hits.length} hits using ${fastaPath}`);

  var onSuccess, onFailure;
  const output = new Promise((resolve, reject) => {
    onSuccess = (resp) => {
      logger('trace:hash')('success')
      resolve(resp)
    };
    onFailure = (resp) => {
      logger('trace:hash')('fail')
      reject(resp)
    };
  });

  const compliment = (b) => {
    return {t: 'a', a: 't', c: 'g', g: 'c'}[b] || b
  }

  const hashHit = (contig, hit) => {
    const { start, end, reverse } = hit;
    var bases;
    if (reverse) {
      bases = _(contig.seq.toLowerCase()).slice(start - 1, end).map(compliment).reverse().value().join('');
    } else {
      bases = _(contig.seq.toLowerCase()).slice(start - 1, end).value().join('');
    }
    const hash = hasha(bases, {algorithm: 'sha1'})
    logger('trace:hash')([contig.id, hit.allele, bases.slice(0,10), bases.slice(-10), hash])
    return hash
  }

  const seqStream = fasta.obj(fastaPath);
  seqStream.on('data', contig => {
    _.forEach(hits, (hit, idx) => {
      if (hit.sequence != contig.id) return;
      const hash = hashHit(contig, hit);
      hit.hash = hash;
      logger('trace:hash')(`added hash '${hash}' to hit ${idx}`)
    })
  });

  seqStream.on('end', () => {
    const missingHashes = _.filter(hits, hit => {
      return typeof(hit.hash) == 'undefined';
    }).length;
    if (missingHashes) {
      onFailure(`${missingHashes} hits couldn't be hashed`)
    } else {
      logger('trace:hash')(`Finshed adding hashes to hits using ${fastaPath}`)
      onSuccess(hits)
    }
  });

  return output;
}

function addMatchingAllelesToHits(alleleHashes, hits) {
  _.forEach(hits, hit => {
    const matchingAllele = alleleHashes[hit.hash];
    if (matchingAllele) {
      hit.matchingAllele = matchingAllele;
    }
  });
  return hits;
}

const blastDb = makeBlastDb(SAMPLE);
const hits = new BlastHitsStore(alleleLengths);

function startBlast(options={}){
  const { streams, db, wordSize, pIdent } = options;

  const blast = createBlastProcess(db, wordSize, pIdent);
  const blastInputStream = makeBlastInputStream();
  _.forEach(streams, stream => {
    stream.pipe(blastInputStream);
  })
  blastInputStream.pipe(blast.stdin);

  const blastResultsStream = readline.createInterface({
    input: blast.stdout,
  })

  return { blast, blastInputStream, blastResultsStream }
}

function processBlastResultsStream(options={}) {
  const { streams, blast, blastResultsStream } = options;

  blastResultsStream.on('line', line => {
    const hit = hits.buildHit(line);
    if (hits.update(hit)) {
      logger('trace:addedHit')(line);
    } else {
      logger('trace:skippedHit')(line);
    }
  })

  return Promise.all(_.map(streams, stream => {
    return stream.whenEmpty()
  })).then(() => {
    logger('streams:length')(_.map(streams, s => { return s.length() }));
    // logger('streams:length')(_.keys(streams[0]));
  })
}

function stopBlast(options={}) {
  const { blast, blastInputStream } = options;

  var onExit;
  const output = new Promise((resolve, reject) => {
    onExit = resolve
  });

  blastInputStream.end();
  blast.on('exit', (code, signal) => {
    onExit(options)
  });

  return output
}

function filterResults(hits) {
  return _.reduce(hits, (results, hit) => {
    if (!hit.matchingAllele) results.imperfect.push(hit)
    else if (hit.sequenceLength != alleleLengths[hit.matchingAllele]) results.imperfect.push(hit)
    else results.perfect.push(hit)
    return results
  }, {perfect: [], imperfect: []})
}

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
    return { streams, blast, blastResultsStream };
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

firstResults.then(filterResults).then(logger('hits:first')).catch(logger('hits:error'))
