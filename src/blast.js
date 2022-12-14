const { spawn } = require("child_process");
const _ = require("lodash");
const fasta = require("bionode-fasta");
const logger = require("debug");
const path = require("path");
const tmp = require("tmp-promise");

const { Transform } = require("stream");

const { parseAlleleName } = require("./mlst-database");
const {
  DeferredPromise,
  loadSequencesFromStream,
  FastaString
} = require("./utils");

const findBackSlashes = /\\/g;
const findForwardSlashes = /\//g;
const findTabs = /\t/g;
const findQuotes = /"/g;

class RenameContigs extends Transform {
  constructor(options = {}) {
    super(_.assign(options, { objectMode: true }));
    this.nameMap = {};
    this.count = 0;
  }

  _transform(sequence, encoding, callback) {
    const record = JSON.parse(sequence.toString())
    const newName = `contig_${this.count}`;
    this.nameMap[newName] = record.id;
    this.count++;
    this.push(_.assign(record, { id: newName }));
    callback();
  }
}

async function makeBlastDb(inputFileStream) {

  const output = new DeferredPromise();
  const { path: blastDir } = await tmp.dir({
    mode: "0750",
    prefix: "mlst_blast_",
    unsafeCleanup: true
  });
  const contigRenamer = new RenameContigs();
  const originalFasta = fasta();
  const renamedFasta = originalFasta
    .pipe(contigRenamer)
    .pipe(new FastaString());

  const whenRenamedSequences = loadSequencesFromStream(renamedFasta);

  const databasePath = path.join(blastDir, "blast.db");
  const command = `makeblastdb -title mlst -in - -dbtype nucl -out ${databasePath}`;
  logger("cgps:debug:blast:makeBlastDb")(
    `Creating Blast database '${databasePath}'`
  );
  logger("cgps:trace:blast:makeBlastDb")(`Running '${command}'`);
  const shell = spawn(command, { shell: true });

  shell.stdin.on("error", err => {
    logger("cgps:error:blast:makeBlastDb")(err);
    output.reject(err);
  });

  shell.on("error", err => {
    logger("cgps:error:blast:makeBlastDb")(err);
    output.reject(err);
  });
  shell.on("exit", async (code, signal) => {
    if (code === 0) {
      logger("cgps:debug:blast:makeBlastDb")(
        `Created Blast database '${databasePath}'`
      );
      const renamedSequences = await whenRenamedSequences;
      output.resolve({
        contigNameMap: contigRenamer.nameMap,
        blastDb: databasePath,
        renamedSequences
      });
    } else {
      output.reject(`Got ${code}:${signal} while building BlastDB`);
    }
  });

  renamedFasta.pipe(shell.stdin);

  const cleanFasta = new Transform({
    transform(chunk, encoding, callback) {
      callback(null, chunk.toString()
        .replace(findBackSlashes, '\\')
        .replace(findForwardSlashes, '\/')
        .replace(findTabs, '\\t')
        .replace(findQuotes, '\"'));
    }
  })

  inputFileStream.pipe(cleanFasta).pipe(originalFasta);
  return output.promise;
}

function createBlastProcess(db, wordSize, percIdentity) {
  if ([db, wordSize, percIdentity].indexOf(undefined) > -1) throw Error("db, wordSize, percIdentity must all be defined")
  const blastExit = new DeferredPromise();
  const command =
    "blastn -task blastn " +
    "-max_target_seqs 10000 " +
    "-query - " +
    `-db ${db} ` +
    '-outfmt "6 qseqid sseqid pident length mismatch gapopen ' +
    'qstart qend sstart send evalue bitscore nident" ' +
    `-word_size ${wordSize} ` +
    `-perc_identity ${percIdentity}`;
  logger("cgps:debug:blast:run")(`Running '${command}'`);
  const blastShell = spawn(command, { shell: true });
  blastShell.stdin.on("error", err => blastExit.reject(err));
  blastShell.on("error", err => blastExit.reject(err));
  blastShell.on("exit", (code, signal) => {
    if (code !== 0) blastExit.reject(`Blast exited with ${code} (${signal})`);
    blastExit.resolve();
  });

  blastShell.stderr.pipe(process.stderr);
  return [blastShell, blastExit.promise];
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
