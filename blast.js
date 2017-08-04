#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const _ = require('lodash');
const logger = require('debug');
const tmp = require('tmp');
const path = require('path');

const { parseAlleleName } = require('./mlst-database')

tmp.setGracefulCleanup();

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

function createBlastProcess(db, word_size=11, perc_identity=0) {
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

class BlastHitsStore {
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
    const NIDENT = 12;

    const row = line.split('\t');
    const allele = row[QUERY];
    const { gene } = parseAlleleName(allele);
    const length = Number(row[LENGTH]);
    const pident = Number(row[PIDENT]);
    const sequence = row[SEQ];
    const [start, end, reverse] = Number(row[SSTART]) < Number(row[SEND]) ? [Number(row[SSTART]), Number(row[SEND]), false] : [Number(row[SEND]), Number(row[SSTART]), true]
    const sequenceLength = end - start + 1;
    const matchingBases = Number(row[NIDENT]);

    return { sequence, gene, allele, length, pident, start, end, reverse, sequenceLength, matchingBases }
  }

  best() {
    return _.map(this._bins, bin => {
      const bestHit = _.reduce(bin.hits, (bestHit, hit) => {
        if (bestHit.matchingBases == hit.matchingBases) {
          return bestHit.pident > hit.pident ? bestHit : hit;
        }
        return bestHit.matchingBases > hit.matchingBases ? bestHit : hit;
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
      if (start <= bin.start && end >= bin.end) return true;
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

module.exports = { makeBlastDb, createBlastProcess, BlastHitsStore };
