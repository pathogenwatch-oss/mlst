#!/usr/bin/env node

const { spawn } = require('child_process');
const commander = require('commander');
const _ = require('lodash');
const readline = require('readline');
const logger = require('debug');
const fasta = require('bionode-fasta');
const fs = require('fs');
const stream = require('stream');

var alleleDir, db;
const program = commander
  .arguments('<alleleDir> <db>')
  .action((_fasta, _db) => {
    alleleDir = _alleleDir;
    db = _db;
  }).parse(process.argv);


if (! fasta || ! db) {
  logger('error')("Need alleleDir and blastdb")
  process.exit(1)
} else {
  logger('debug')(`Using ${alleleDir} and ${db}`)
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
  // return readline.createInterface({
  //   input: blastShell.stdout
  // })
}

function getQuerySequences(alleleDir, number) {
  const sequenceStream = new stream.Readable({ objectMode: true });
  fs.readdir(alleleDir, (err, files) => {

  });
  return
}

const blast=runBlast(fasta, db, 11, 80);
const bins = {};
const BINWIDTH = 500;

blast.on('line', line => {
  const QUERY = 0;
  const DB = 1;
  const PIDENT = 2;
  const LENGTH = 3;
  const MISMATCH = 4;
  const SSTART = 8;
  const SEND = 9;

  const row = line.split('\t');
  if (Number(row[PIDENT]) > 95) {
    logger('debug')(line);
  } else {
    logger('trace')(line)
  }

  // for (var b=(1 + (row[SSTART] % BINWIDTH))*BINWIDTH; b<=(1 + (row[SEND] % BINWIDTH))*BINWIDTH; b+=BINWIDTH) {
  //   if (! bins[b]) bins[b] = [];
  //   bins[b].push(row);
  // }

})

blast.on('close', () => {
  logger('trace')(_.keys(bins));
})
