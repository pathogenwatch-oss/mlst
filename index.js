#!/usr/bin/env node

const { spawn } = require('child_process');
const commander = require('commander');
const _ = require('lodash');
const readline = require('readline');
const logger = require('debug');

var fasta, db;
const program = commander
  .arguments('<fasta> <db>')
  .action((_fasta, _db) => {
    fasta = _fasta;
    db = _db;
  }).parse(process.argv);


if (! fasta || ! db) {
  logger('error')("Need fasta and blastdb")
  process.exit(1)
} else {
  logger('debug')(`Using ${fasta} and ${db}`)
}

function runBlast(fasta, db, word_size=11, perc_identity=0) {
  const command='blastn -task blastn ' +
    '-max_target_seqs 10000 ' +
    '-query $fasta ' +
    '-db $db ' +
    '-outfmt "6 qseqid sseqid pident length mismatch gapopen qstart qend sstart send evalue bitscore nident" ' +
    '-word_size ${word_size} ' +
    '-perc_identity ${perc_identity}';
  const env = Object.create(process.env);
  _.assign(env, {
    fasta,
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
  return readline.createInterface({
    input: blastShell.stdout
  })
}

const blast=runBlast(fasta, db);
const closest = {};
var last_query = "";

blast.on('line', line => {
  const QUERY = 0;
  const DB = 1;
  const PIDENT = 2;
  const LENGHT = 3;
  const MISMATCH = 4;
  const row = line.split('\t');
  const this_score = Number(row[LENGHT]) - Number(row[MISMATCH]);
  const [best, best_score] = closest[row[QUERY]] || ['', 0];
  // console.log([row[QUERY], row[DB], Number(row[PIDENT]), best, pident])
  if (last_query != row[QUERY]) {
    if (last_query) logger('debug')(`New best score: ${[last_query, ...closest[last_query]]}`);
    last_query=row[QUERY];
  }
  if (best_score < this_score && row[QUERY] != row[DB]) {
    closest[row[QUERY]] = [row[DB], this_score]
  }
})
