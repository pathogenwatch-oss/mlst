'use strict';

const _ = require('lodash');
const fasta = require('bionode-fasta');
const hasha = require('hasha');
const logger = require('debug');
const readline = require('readline');
const path = require('path');

const { createBlastProcess } = require('./blast')
const { listAlleleFiles, FastaString } = require('./pubmlst')
const { ObjectTap } = require('./utils')

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


function makeBlastInputStream() {
  return new FastaString({
    highWaterMark: 10000,
  })
}

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
  const { hits, streams, blast, blastResultsStream } = options;

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

function filterResults(options={}) {
  const { bestHits, alleleLengths } = options;
  return _.reduce(bestHits, (results, hit) => {
    if (!hit.matchingAllele) results.imperfect.push(hit)
    else if (hit.sequenceLength != alleleLengths[hit.matchingAllele]) results.imperfect.push(hit)
    else results.perfect.push(hit)
    return results
  }, {perfect: [], imperfect: []})
}

module.exports = {
  getAlleleStreams, addHashesToHits, addMatchingAllelesToHits,
  startBlast, processBlastResultsStream, stopBlast, filterResults
}
