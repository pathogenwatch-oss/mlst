#!/usr/bin/env node

const { spawn } = require("child_process");
const _ = require("lodash");
const fasta = require("bionode-fasta");
const logger = require("debug");
const tmp = require("tmp");
const path = require("path");

const { Transform } = require("stream");

const { parseAlleleName, FastaString } = require("./mlst-database");
const { DeferredPromise, loadSequencesFromStream } = require("./utils");

tmp.setGracefulCleanup();

class RenameContigs extends Transform {
  constructor(options = {}) {
    super(_.assign(options, { objectMode: true }));
    this.nameMap = {};
    this.count = 0;
  }

  _transform(sequence, encoding, callback) {
    const newName = `contig_${this.count}`;
    this.nameMap[newName] = sequence.id;
    this.count++;
    this.push(_.assign(sequence, { id: newName }));
    callback();
  }
}

function makeBlastDb(inputFileStream) {
  const whenContigNameMap = new DeferredPromise();
  const whenRenamedSequences = new DeferredPromise();
  const whenBlastDb = new DeferredPromise();

  const whenBlastDirCreated = new Promise((resolve, reject) => {
    tmp.dir({ mode: "0750", prefix: "mlst_blast_" }, (err, blastDir) => {
      if (err) reject(err);
      resolve(blastDir);
    });
  });

  const contigRenamer = new RenameContigs();
  const renamedFasta = inputFileStream
    .pipe(fasta.obj())
    .pipe(contigRenamer)
    .pipe(new FastaString());

  whenBlastDirCreated.then(dir => {
    const databasePath = path.join(dir, "blast.db");
    const command =
      `makeblastdb -title mlst -in - ` + `-dbtype nucl -out ${databasePath}`;
    logger("debug:blast:makeBlastDb")(
      `Creating Blast database '${databasePath}'`
    );
    logger("trace:blast:makeBlastDb")(`Running '${command}'`);
    const shell = spawn(command, { shell: true });
    renamedFasta.pipe(shell.stdin);
    loadSequencesFromStream(renamedFasta)
      .then(whenRenamedSequences.resolve.bind(whenRenamedSequences))
    shell.on("exit", (code, signal) => {
      if (code === 0) {
        logger("debug:blast:makeBlastDb")(
          `Created Blast database '${databasePath}'`
        );
        whenContigNameMap.resolve(contigRenamer.nameMap);
        whenBlastDb.resolve(databasePath);
      } else {
        whenContigNameMap.reject(
          `Got ${code}:${signal} while building BlastDB`
        );
        whenBlastDb.reject(`Got ${code}:${signal} while building BlastDB`);
      }
    });
  });

  return { whenContigNameMap, whenRenamedSequences, whenBlastDb };
}

function createBlastProcess(db, wordSize = 11, percIdentity = 0) {
  const command =
    "blastn -task blastn " +
    "-max_target_seqs 10000 " +
    "-query - " +
    `-db ${db} ` +
    '-outfmt "6 qseqid sseqid pident length mismatch gapopen ' +
    'qstart qend sstart send evalue bitscore nident" ' +
    `-word_size ${wordSize} ` +
    `-perc_identity ${percIdentity}`;
  logger("debug:blast:run")(`Running '${command}'`);
  const blastShell = spawn(command, { shell: true });

  blastShell.stderr.pipe(process.stderr);
  return blastShell;
}

class BlastHitsStore {
  constructor(alleleLengths, contigNameMap) {
    this.alleleLengths = alleleLengths;
    this.contigNameMap = contigNameMap;
    this._bins = [];
  }

  update(hit) {
    if (!this.longEnough(hit.allele, hit.length)) return false;
    const bin = this.getBin(hit.gene, hit.start, hit.end, hit.sequenceId);
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

    const row = line.split("\t");
    const allele = row[QUERY];
    const { gene } = parseAlleleName(allele);
    const length = Number(row[LENGTH]);
    const pident = Number(row[PIDENT]);
    const sequenceId = row[SEQ];
    const [start, end, reverse] =
      Number(row[SSTART]) < Number(row[SEND])
        ? [Number(row[SSTART]), Number(row[SEND]), false]
        : [Number(row[SEND]), Number(row[SSTART]), true];
    const sequenceLength = end - start + 1;
    const matchingBases = Number(row[NIDENT]);

    return {
      sequenceId,
      gene,
      allele,
      length,
      pident,
      start,
      end,
      reverse,
      sequenceLength,
      matchingBases
    };
  }

  best() {
    return _.map(this._bins, bin => {
      const bestHit = _.reduce(bin.hits, (currentBestHit, hit) => {
        if (currentBestHit.matchingBases === hit.matchingBases) {
          return currentBestHit.pident > hit.pident ? currentBestHit : hit;
        }
        return currentBestHit.matchingBases > hit.matchingBases
          ? currentBestHit
          : hit;
      });
      bestHit.alleleLength = this.alleleLengths[bestHit.allele];
      bestHit.sequence = this.contigNameMap[bestHit.sequenceId];
      return bestHit;
    });
  }

  longEnough(allele, length) {
    return length >= this.alleleLengths[allele] * 0.8;
  }

  // eslint-disable-next-line max-params
  getBin(gene, start, end, sequenceId) {
    const existingBin = _.find(this._bins, bin => {
      if (bin.gene !== gene) return false;
      if (bin.sequenceId !== sequenceId) return false;
      if (bin.start <= start && bin.end >= end) return true;
      if (start <= bin.start && end >= bin.end) return true;
      if (bin.start <= start && end > bin.end) {
        const overlap = Math.abs((bin.end - bin.start) / (end - start));
        return overlap > 0.8;
      }
      if (start <= bin.start && end > bin.end) {
        const overlap = Math.abs((bin.end - bin.start) / (end - start));
        return overlap > 0.8;
      }
      return false;
    });
    if (existingBin) {
      return existingBin;
    }
    const newBin = { gene, start, end, sequenceId, hits: [], bestPIdent: 0 };
    this._bins.push(newBin);
    return newBin;
  }

  closeEnough(pident, bin) {
    return pident >= bin.bestPIdent - 2.0;
  }

  updateBin(bin, hit) {
    /* eslint-disable no-param-reassign */
    bin.start = bin.start < hit.start ? bin.start : hit.start;
    bin.end = bin.end > hit.end ? bin.end : hit.end;
    if (hit.pident > bin.bestPIdent) {
      bin.bestPIdent = hit.pident;
      bin.hits = _.filter(bin.hits, h => this.closeEnough(h.pident, bin));
    }
    bin.hits.push(hit);
    /* eslint-enable no-param-reassign */
  }
}

module.exports = { makeBlastDb, createBlastProcess, BlastHitsStore };
