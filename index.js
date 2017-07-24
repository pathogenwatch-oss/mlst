#!/usr/bin/env node

'use strict';

const fasta = require('bionode-fasta');
const { spawn } = require('child_process');
const _ = require('lodash');
const readline = require('readline');
const logger = require('debug');
const tmp = require('tmp');
const path = require('path');
const hasha = require('hasha');

tmp.setGracefulCleanup();

const { listAlleleFiles, getAlleleHashes, FastaString, AlleleStream } = require('./pubmlst')

function makeBlastDb(fastaPath) {
  const blastDir = new Promise((resolve, reject) => {
    tmp.dir({ mode: '0750', prefix: 'mlst_blast_'}, (err, tempDir) => {
      if (err) reject(err);
      resolve(tempDir);
    })
  })
  return blastDir.then(dir => {
    const databasePath = path.join(dir, 'blast.db');
    const command = `makeblastdb -in ${fastaPath} -dbtype nucl -out ${databasePath}`
    logger('makeBlast')(`Creating Blast database '${databasePath}' from ${fastaPath}`)
    const shell = spawn(command, { shell: true });
    const output = new Promise((resolve, reject) => {
      shell.on('exit', (code, signal) => {
        if (code == 0) {
          logger('makeBlast')(`Created Blast database '${databasePath}' from ${fastaPath}`)
          resolve(databasePath);
        }
        reject([code, signal])
      });
    })
    return output;
  });
}

function runBlast(db, word_size=11, perc_identity=0) {
  const command='blastn -task blastn ' +
    '-max_target_seqs 10000 ' +
    '-query - ' +
    '-db $db ' +
    '-outfmt "6 qseqid sseqid pident length mismatch gapopen qstart qend sstart send evalue bitscore nident" ' +
    '-word_size ${word_size} ' +
    '-perc_identity ${perc_identity}';
  const env = Object.create(process.env);
  _.assign(env, {
    db,
    word_size,
    perc_identity
  });
  logger('debug')(`Running '${command}' with environment:\n${JSON.stringify(env, null, 2)}`)
  const blastShell = spawn(command, {
    shell: true,
    env
  })
  blastShell.stderr.pipe(process.stderr);
  return blastShell;
}

const SPECIES="Staphylococcus aureus"
const SAMPLE='/data/saureus_7hlohgcu9cho/MRSA_10C.fasta';
const alleleHashes = getAlleleHashes(SPECIES);
const NUMBER_OF_ALLELES=1;

var onAlleleSizes;
var alleleSizes = new Promise((resolve, reject) => {
  onAlleleSizes = resolve;
});
const _alleleSizes = {};
var streamPromises = [];
const blastInputStream = (new FastaString({
  highWaterMark: _.keys(alleleHashes).length + 10,
}))
const alleleStreams = [];
listAlleleFiles(SPECIES).then(paths => {
  _.forEach(paths, p => {
    const stream = new AlleleStream(p, NUMBER_OF_ALLELES);
    alleleStreams.push(stream);
    stream.pipe(blastInputStream);
    streamPromises.push(stream.alleleSizes);
  });
  return Promise.all(streamPromises);
}).then(listOfAlleleSizes => {
  logger('stream')(`${listOfAlleleSizes.length} streams are ready`)
  _.assign(_alleleSizes, ...listOfAlleleSizes)
  logger('sizes')(_alleleSizes)
  onAlleleSizes(_alleleSizes);
  blastInputStream.end();
});

class HitsStore {
  constructor(alleleLengths) {
    this.alleleLengths = alleleLengths;
    this._bins = []
  }

  update(hit) {
    if (!this.longEnough(hit.allele, hit.length)) return false;
    const bin = this.getBin(hit.gene, hit.start, hit.end);
    if (!this.closeEnough(hit.pident, bin)) return false;
    this.updateBin(bin, hit);
    return true;
  }

  buildHit(line) {
    const QUERY = 0;
    const SEQ = 1;
    const PIDENT = 2;
    const LENGTH = 3;
    const SSTART = 8;
    const SEND = 9;

    const row = line.split('\t');
    const allele = row[QUERY];
    const gene = allele.split('_')[0];
    const length = Number(row[LENGTH]);
    const pident = Number(row[PIDENT]);
    const sequence = row[SEQ];
    const [start, end, reverse] = Number(row[SSTART]) < Number(row[SEND]) ? [Number(row[SSTART]), Number(row[SEND]), false] : [Number(row[SEND]), Number(row[SSTART]), true]

    return { sequence, gene, allele, length, pident, start, end, reverse }
  }

  best() {
    return _.map(this._bins, bin => {
      const bestHit = _.reduce(bin.hits, (bestHit, hit) => {
        if (bestHit.length == hit.length) {
          return bestHit.pident > hit.pident ? bestHit : hit;
        }
        return bestHit.length > hit.length ? bestHit : hit;
      })
      bestHit.alleleLength = this.alleleLengths[bestHit.allele];
      return bestHit;
    })
  }

  longEnough(allele, length) {
    return length >= this.alleleLengths[allele] * 0.8;
  }

  getBin(gene, start, end) {
    const bin = _.find(this._bins, bin => {
      if (bin.gene != gene) return false;
      if (bin.start <= start && bin.end >= end) return true;
      if (start <= bins.start && end >= bin.end) return true;
      if (bin.start <= start && end > bin.end) {
        overlap = Math.abs((bin.end - bin.start)/(end - start));
        return overlap > 0.8;
      }
      if (start <= bin.start && end > bin.end) {
        overlap = Math.abs((bin.end - bin.start)/(end - start));
        return overlap > 0.8;
      }
      return false;
    })
    if (bin) {
      return bin;
    } else {
      const newBin = { gene, start, end, hits: [], bestPIdent: 0 }
      this._bins.push(newBin);
      return newBin;
    }
  }

  closeEnough(pident, bin) {
    return pident >= bin.bestPIdent - 2.0;
  }

  updateBin(bin, hit) {
    bin.start = bin.start < hit.start ? bin.start : hit.start;
    bin.end = bin.end > hit.end ? bin.end : hit.end;
    if (hit.pident > bin.bestPIdent) {
      bin.bestPIdent = hit.pident;
      bin.hits = _.filter(bin.hits, h => {
        return this.closeEnough(h.pident, bin);
      })
    }
    bin.hits.push(hit);
  }
}

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

// var done = false;
const blastDb = makeBlastDb(SAMPLE);
Promise.all([alleleSizes, blastDb]).then(([sizes, db]) => {
  logger('debug')(`Got allele sizes and a blast db (${db})`)
  const hits = new HitsStore(sizes);
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
      // logger('skipped')(line);
    }
  })

  var onExit;
  const output = new Promise((resolve, reject) => {
    onExit = resolve;
  });

  blast.on('exit', (code, signal) => {
    onExit(hits.best())
  })

  return output
}).then(hits => {
  // logger('hits')(hits);
  const matched_hits = _.map(hits, hit => {
    logger('hashMatching')(hit)
    return hashSequence(SAMPLE, hit.sequence, hit.start, hit.end, hit.reverse).then(hash => {
      hit.match = alleleHashes[hash] || 'Unknown';
      hit.hash = hash;
      logger('hashMatched')(`Hashed matching region of ${hit.sequence} to ${hash}`)
      return hit
    })
  });
  return Promise.all(matched_hits)
}).then(logger('matches'))
