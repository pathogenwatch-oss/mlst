#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const _ = require('lodash');
const fasta = require('bionode-fasta');
const fs = require('fs');
const logger = require('debug');
const tmp = require('tmp');
const path = require('path');

const { Transform } = require('stream');

const { parseAlleleName, FastaString } = require('./mlst-database')
const { DeferredPromise } = require('./utils')

tmp.setGracefulCleanup();

class RenameContigs extends Transform {
  constructor(options={}) {
    options.objectMode = true;
    super(options)
    this.nameMap = {}
    this.count = 0;
  }

  _transform(sequence, encoding, callback) {
    const newName = `contig_${this.count}`
    this.nameMap[newName] = sequence.id;
    sequence.id = newName;
    this.count++;
    this.push(sequence);
    callback();
  }
}

function makeBlastDb(fastaPath) {
  const whenContigNameMap = new DeferredPromise();
  const whenBlastDb = new DeferredPromise();

  const whenBlastDirCreated = new Promise((resolve, reject) => {
    tmp.dir({ mode: '0750', prefix: 'mlst_blast_'}, (err, blastDir) => {
      if (err) reject(err);
      resolve(blastDir);
    })
  })

  const contigRenamer = new RenameContigs();
  const renamedFasta = fasta.obj(fastaPath)
    .pipe(contigRenamer)
    .pipe(new FastaString())

  whenBlastDirCreated.then(dir => {
    const databasePath = path.join(dir, 'blast.db');
    const command = `makeblastdb -title "${fastaPath}" -in - -dbtype nucl -out ${databasePath}`
    logger('debug:blast:makeBlastDb')(`Creating Blast database '${databasePath}' from ${fastaPath}`)
    logger('trace:blast:makeBlastDb')(`Running '${command}'`)
    const shell = spawn(command, { shell: true });
    renamedFasta.pipe(shell.stdin);
    shell.on('exit', (code, signal) => {
      if (code == 0) {
        logger('debug:blast:makeBlastDb')(`Created Blast database '${databasePath}' from ${fastaPath}`)
        whenContigNameMap.resolve(contigRenamer.nameMap)
        whenBlastDb.resolve(databasePath)
      } else {
        whenContigNameMap.reject(`Got ${code}:${signal} while building BlastDB`)
        whenBlastDb.reject(`Got ${code}:${signal} while building BlastDB`)
      }
    });
  });

  return {whenContigNameMap, whenBlastDb}
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
  logger('debug:blast:run')(`Running '${command}' with environment:\n${JSON.stringify(env, null, 2)}`)
  const blastShell = spawn(command, {
    shell: true,
    env
  })

  blastShell.stderr.pipe(process.stderr);
  return blastShell;
}

class BlastHitsStore {
  constructor(alleleLengths, contigNameMap) {
    this.alleleLengths = alleleLengths;
    this.contigNameMap = contigNameMap;
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
    const sequenceId = row[SEQ];
    const [start, end, reverse] = Number(row[SSTART]) < Number(row[SEND]) ? [Number(row[SSTART]), Number(row[SEND]), false] : [Number(row[SEND]), Number(row[SSTART]), true]
    const sequenceLength = end - start + 1;
    const matchingBases = Number(row[NIDENT]);

    return { sequenceId, gene, allele, length, pident, start, end, reverse, sequenceLength, matchingBases }
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
      bestHit.sequence = this.contigNameMap[bestHit.sequenceId];
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
