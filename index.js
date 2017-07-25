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
const { makeBlastDb, runBlast, BlastHitsStore } = require('./blast')

const SPECIES="Staphylococcus aureus"
const SAMPLE='/data/saureus_7hlohgcu9cho/MRSA_10C.fasta';

const alleleMetadata = readMetadata(SPECIES);
const alleleHashes = alleleMetadata['hashes'];
const alleleLengths = alleleMetadata['lengths'];

const NUMBER_OF_ALLELES=2;

const blastInputStream = (new FastaString({
  highWaterMark: _.keys(alleleLengths).length + 10,
}))
// blastInputStream.pipe(process.stderr);

const alleleStreams = listAlleleFiles(SPECIES).then(paths => {
  const streams = {};
  _.forEach(paths, p => {
    const allele = path.basename(p, '.tfa')
    const stream = fasta.obj(p).pipe(new ObjectTap(NUMBER_OF_ALLELES));
    logger('stream')(`Streaming ${allele} to blastInputStream`)
    stream.pipe(blastInputStream);
    streams[allele] = stream;
  });
  return streams;
})

function hashSequence(fastaPath, contig, start, end, reverse) {
  logger('hashing')(`Looking for ${contig} in ${fastaPath}`);
  const seqStream = fasta.obj(fastaPath);
  const compliment = (b) => {
    return {t: 'a', a: 't', c: 'g', g: 'c'}[b] || b
  }
  var onSuccess, onFailure;
  const output = new Promise((resolve, reject) => {
    onSuccess = resolve;
    onFailure = reject;
  });
  seqStream.on('data', seq => {
    // logger('seq')(seq);
    if (seq.id != contig) return;
    logger('hashing')(`Found sequence for ${contig}`)
    var bases;
    if (reverse) {
      bases = _(seq.seq.toLowerCase()).slice(start - 1, end).map(compliment).reverse().value();
    } else {
      bases = _(seq.seq.toLowerCase()).slice(start - 1, end).value();
    }
    logger('bases')([contig, _.slice(bases, 0, 10).join(''), _.slice(bases, bases.length-10).join('')]);
    onSuccess(hasha(bases.join(''), {algorithm: 'sha1'}))
  });
  seqStream.on('end', () => {
    logger('hashing')(`Finished reading ${fastaPath}`)
    Promise.race([output, Promise.resolve(null)]).then(hash => {
      if (!hash) {
        onFailure(`Couldn't find a contig called ${contig} in ${fastaPath}`)
      }
    });
  });
  return output;
}

const blastDb = makeBlastDb(SAMPLE);
Promise.all([alleleStreams, blastDb]).then(([streams, db]) => {
  const hits = new BlastHitsStore(alleleLengths);
  const blast = runBlast(db, 11, 80);
  blastInputStream.pipe(blast.stdin);

  const blastResultsStream = readline.createInterface({
    input: blast.stdout,
  })

  blastResultsStream.on('line', line => {
    const hit = hits.buildHit(line);
    if (hits.update(hit)) {
      logger('added')(line);
    } else {
      logger('skipped')(line);
    }
  })

  return Promise.all(_.map(alleleStreams, s => { return s.waitForPause })).then(() => { return { hits, blast } });
}).then(({hits, blast}) => {
  blastInputStream.end();
  blast.on('exit', (code, signal) => {
    logger('best')(hits.best());
  });
})

// .then(hits => {
//   // logger('hits')(hits);
//   const matched_hits = _.map(hits, hit => {
//     logger('hashMatching')(hit)
//     return hashSequence(SAMPLE, hit.sequence, hit.start, hit.end, hit.reverse).then(hash => {
//       hit.match = alleleHashes[hash] || 'Unknown';
//       hit.hash = hash;
//       logger('hashMatched')(`Hashed matching region of ${hit.sequence} to ${hash}`)
//       return hit
//     })
//   });
//   return Promise.all(matched_hits)
// }).then(logger('matches'))
