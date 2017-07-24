#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const _ = require('lodash');
const readline = require('readline');
const logger = require('debug');

const { listAlleleFiles, FastaString, AlleleStream } = require('./pubmlst')

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
const DB="/code/blast_dbs/Staphylococcus_aureus/saureus_7hlohgcu9cho/MRSA_10C.db"

var onAlleleSizes;
var alleleSizes = new Promise((resolve, reject) => {
  onAlleleSizes = resolve;
});
const _alleleSizes = {};
var streamPromises = [];
const blastInputStream = (new FastaString())
const alleleStreams = [];
listAlleleFiles(SPECIES).then(paths => {
  _.forEach(paths, p => {
    logger('makeStream')(`Made a stream from ${p}`);
    const stream = new AlleleStream(p, 3);
    alleleStreams.push(stream);
    stream.pipe(blastInputStream);
    streamPromises.push(stream.alleleSizes);
  });
  return Promise.all(streamPromises);
}).then(listOfAlleleSizes => {
  _.assign(_alleleSizes, ...listOfAlleleSizes)
  logger('sizes')(_alleleSizes)
  onAlleleSizes(_alleleSizes);
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
    const [start, end, reverse] = Number(row[SSTART]) < Number(row[SEND]) ? [Number(row[SSTART]), Number(row[SEND]), false] : [Number(row[SEND]), Number(row[SSTART]), true]

    return { gene, allele, length, pident, start, end, reverse }
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

var hits;
alleleSizes.then(sizes => {
  hits = new HitsStore(sizes);
  const blast = runBlast(DB, 11, 80);
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
})

setTimeout(() => {
  blastInputStream.end();
  logger('best')(hits.best());
}, 3000);
