#!/usr/bin/env node

const { spawn } = require("child_process");
const _ = require("lodash");
const fasta = require("bionode-fasta");
const logger = require("debug");
const path = require("path");
const tmp = require("tmp");

const { Transform } = require("stream");

const { FastaString } = require("./mlst-database");
const { parseAlleleName, DeferredPromise, loadSequencesFromStream } = require("./utils");

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
    tmp.dir(
      { mode: "0750", prefix: "mlst_blast_", unsafeCleanup: true },
      (err, blastDir) => {
        if (err) reject(err);
        resolve(blastDir);
      }
    );
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
    loadSequencesFromStream(renamedFasta).then(
      whenRenamedSequences.resolve.bind(whenRenamedSequences)
    );
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

function parseBlastLine(line) {
  const QUERY = 0;
  const SEQ = 1;
  const PIDENT = 2;
  const LENGTH = 3;
  const QSTART = 6;
  const QEND = 7;
  const SSTART = 8;
  const SEND = 9;
  const NIDENT = 12;

  const row = line.split("\t");
  const allele = row[QUERY];
  const { gene, st } = parseAlleleName(allele);
  const alleleLength = Number(row[LENGTH]);
  const pident = Number(row[PIDENT]);
  const contigId = row[SEQ];
  const [contigStart, contigEnd, reverse] =
    Number(row[SSTART]) < Number(row[SEND])
      ? [Number(row[SSTART]), Number(row[SEND]), false]
      : [Number(row[SEND]), Number(row[SSTART]), true];
  const [alleleStart, alleleEnd] = 
    Number(row[QSTART]) < Number(row[QEND])
    ? [Number(row[QSTART]), Number(row[QEND])]
    : [Number(row[QEND]), Number(row[QSTART])];
  const contigLength = contigEnd - contigStart + 1;
  const matchingBases = Number(row[NIDENT]);

  return {
    allele,
    contigId,
    gene,
    st,
    alleleLength,
    pident,
    contigStart,
    contigEnd,
    alleleStart,
    alleleEnd,
    reverse,
    contigLength,
    matchingBases
  };
}

module.exports = { makeBlastDb, createBlastProcess, parseBlastLine };
