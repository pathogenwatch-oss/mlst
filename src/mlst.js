'use strict';

const _ = require('lodash');
const es = require('event-stream');
const fasta = require('bionode-fasta');
const hasha = require('hasha');
const logger = require('debug');
const path = require('path');

const { createBlastProcess } = require('./blast')
const { parseAlleleName, listAlleleFiles, FastaString } = require('./mlst-database')
const { ObjectTap, DeferredPromise } = require('./utils')

function getAlleleStreams(allelePaths, limit) {
  const streams = {};
  _.forEach(allelePaths, p => {
    const allele = path.basename(p, '.tfa');
    const objectLimiter = new ObjectTap({limit});
    const stream = fasta.obj(p).pipe(objectLimiter);
    streams[allele] = stream;
  });
  return streams;
}

function addHashesToHits(fastaPath, hits) {
  logger('trace:hash')(`About to add hashes to ${hits.length} hits using ${fastaPath}`);

  const output = new DeferredPromise();

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
    const unhashedHits = _.filter(hits, hit => {
      return typeof(hit.hash) == 'undefined';
    });
    if (unhashedHits.length > 0) {
      const missingHitSequences = _.map(unhashedHits, hit => `* ${hit.sequence}`)
      logger('error')(`Couldn't find the following in ${fastaPath}:\n${missingHitSequences.join('\n')}`)
      output.reject(`${unhashedHits.length} hits couldn't be hashed`);
    } else {
      logger('trace:hash')(`Finished adding hashes to hits using ${fastaPath}`)
      output.resolve(hits);
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
  const blastResultsStream = blast.stdout.pipe(es.split())

  return { blast, blastInputStream, blastResultsStream }
}

function processBlastResultsStream(options={}) {
  const { hitsStore, streams, blast, blastResultsStream } = options;

  blastResultsStream.on('data', line => {
    if (line == '') return;
    const hit = hitsStore.buildHit(line);
    if (hitsStore.update(hit)) {
      logger('trace:mlst:addedHit')(line);
    } else {
      logger('trace:mlst:skippedHit')(line);
    }
  })

  return Promise.all(_.map(streams, stream => {
    return stream.whenEmpty()
  }))
}

function stopBlast(options={}) {
  const { blast, blastInputStream } = options;
  const output = new DeferredPromise()

  blastInputStream.end();
  blast.on('exit', (code, signal) => {
    output.resolve(options)
  });

  return output
}

function buildResults(options={}) {
  const { bestHits, alleleLengths, genes, profiles, scheme, commonGeneLengths } = options;

  // logger('tmp')(options);

  const hitToResult = hit => {
    const { sequence, start, end, reverse, gene, sequenceLength, alleleLength, hash, matchingAllele, matchingBases } = hit;
    const perfect = (!!matchingAllele && (sequenceLength == alleleLengths[matchingAllele]))
    const allele = matchingAllele ? parseAlleleName(matchingAllele)['st'] : null;
    const closestAllele = parseAlleleName(hit.allele)['st'];
    const closestAlleleLength = alleleLengths[hit.allele] || null;
    return {
      blastResult: {
        contig: sequence,
        start,
        end,
        reverse,
        matchingBases,
        closestAllele,
        closestAlleleLength: closestAlleleLength || null,
      },
      perfect,
      length: sequenceLength,
      alleleLength: alleleLengths[matchingAllele] || null,
      hash,
      allele,
      modeGeneLength: Number(commonGeneLengths[gene]),
    }
  }

  const alleles = {};
  const raw = {};

  _.forEach(bestHits, hit => {
    const { gene } = hit;
    const result = hitToResult(hit);
    const { allele, hash, blastResult, length, modeGeneLength } = result;
    if (allele) {
      (alleles[gene] = alleles[gene] || []).push(allele);
    } else if (blastResult.matchingBases > 0.8*modeGeneLength && length < 1.1*modeGeneLength) {
      (alleles[gene] = alleles[gene] || []).push(hash);
    }
    (raw[gene] = raw[gene] || []).push(result);
  })

  const results = {
    alleles: _.zip(genes, _.map(genes, gene => {
      return (alleles[gene] || []).join(',').toLowerCase()
    })),
    raw,
  };

  const code = _.map(genes, gene => {
    return (alleles[gene] || []).join(',');
  }).join('_').toLowerCase();

  const st = profiles[code] ? profiles[code] : hasha(code.toLowerCase(), {algorithm: 'sha1'})
  results['st'] = st;
  results['code'] = code;
  results['scheme'] = scheme;

  return results;
}

module.exports = {
  getAlleleStreams, addHashesToHits, addMatchingAllelesToHits,
  startBlast, processBlastResultsStream, stopBlast, buildResults
}
