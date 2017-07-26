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

const NUMBER_OF_ALLELES=10;

const makeBlastInputStream = () => {
  return new FastaString({
    highWaterMark: _.keys(alleleLengths).length + 10,
  })
}

// logger('debug')(`highWaterMark: ${_.keys(alleleLengths).length}`)

const alleleStreams = listAlleleFiles(SPECIES).then(paths => {
  const streams = {};
  _.forEach(paths, p => {
    const allele = path.basename(p, '.tfa')
    const stream = fasta.obj(p).pipe(new ObjectTap({limit: NUMBER_OF_ALLELES}));
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
const firstRun = Promise.all([alleleStreams, blastDb]).then(([streams, db]) => {
  const hits = new BlastHitsStore(alleleLengths);
  const blast = runBlast(db, 30, 80);

  const blastInputStream = makeBlastInputStream();
  _.forEach(_.values(streams), stream => {
    stream.pipe(blastInputStream);
  })
  blastInputStream.pipe(blast.stdin);
  // blastInputStream.pipe(process.stderr);

  const blastResultsStream = readline.createInterface({
    input: blast.stdout,
  })

  blastResultsStream.on('line', line => {
    const hit = hits.buildHit(line);
    if (hits.update(hit)) {
      logger('trace:addedHit')(line);
    } else {
      logger('trace:skippedHit')(line);
    }
  })

  const streamPromises = _.map(_.values(streams), s => { return s.whenEmpty() });
  return Promise.all(streamPromises).then(() => {
    logger('streams')('All streams are empty');
    return { hits, blast, db, blastInputStream };
  });
}).then(({hits, blast, db, blastInputStream }) => {
  var onExit;
  const output = new Promise((resolve, reject) => {
    onExit = resolve
  });

  blastInputStream.end();
  blast.on('exit', (code, signal) => {
    onExit({hits, db})
  });

  return output
}).then(({hits, db}) => {
  logger('hits')(hits.best());
  const { perfectGenes, imperfectGenes } = _.reduce(hits.best(), (results, h) => {
    if (h.length == h.matchingBases && h.matchingBases == h.alleleLength) {
      results.perfectGenes.push(h.gene);
    } else {
      results.imperfectGenes.push(h.gene);
    }
    return results;
  }, {perfectGenes: [], imperfectGenes: []})

  logger('hits:perfect')(perfectGenes);
  return { hits, db };
}).catch(logger('error'))


const secondRun = Promise.all([firstRun, alleleStreams]).then(([{hits, db}, streams]) => {
  logger('debug')('having a second run');
  const { perfectGenes, imperfectGenes } = _.reduce(hits.best(), (results, h) => {
    if (h.length == h.matchingBases && h.matchingBases == h.alleleLength) {
      results.perfectGenes.push(h.gene);
    } else {
      results.imperfectGenes.push(h.gene);
    }
    return results;
  }, {perfectGenes: [], imperfectGenes: []})

  logger('hits:perfect')(perfectGenes);
  // logger('imperfect')(imperfectGenes);
  const blast = runBlast(db, 11, 80);
  const blastInputStream = makeBlastInputStream();
  _.forEach(imperfectGenes, gene => {
    logger('improve')(`Improving hits for ${gene}`);
    const stream = streams[gene];
    stream.pipe(blastInputStream);
    stream.updateLimit(null);
  })
  blastInputStream.pipe(blast.stdin);

  const blastResultsStream = readline.createInterface({
    input: blast.stdout,
  })

  blastResultsStream.on('line', line => {
    const hit = hits.buildHit(line);
    if (hits.update(hit)) {
      logger('trace:addedHit')(line);
    } else {
      logger('trace:skippedHit')(line);
    }
  })

  const streamPromises = _.map(imperfectGenes, gene => {
    return streams[gene].whenEmpty();
  });
  return Promise.all(streamPromises).then(() => {
    logger('streams')('All streams are empty');
    return { hits, blast, db, blastInputStream };
  });
}).then(({hits, blast, db, blastInputStream }) => {
  var onExit;
  const output = new Promise((resolve, reject) => {
    onExit = resolve
  });

  blastInputStream.end();
  blast.on('exit', (code, signal) => {
    onExit({hits, db})
  });

  return output
}).then(({hits, db}) => {
  const { perfectGenes, imperfectGenes } = _.reduce(hits.best(), (results, h) => {
    if (h.length == h.matchingBases && h.matchingBases == h.alleleLength) {
      results.perfectGenes.push(h.gene);
    } else {
      results.imperfectGenes.push(h.gene);
    }
    return results;
  }, {perfectGenes: [], imperfectGenes: []})

  logger('hits:improved')(hits.best());
  logger('hits:perfect')(perfectGenes);
  return hits;
}).catch(logger('error'))

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
