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

const blast=runBlast(DB, 11, 80);
blastInputStream.pipe(blast.stdin);
// blastInputStream.pipe(process.stderr);

const blastResultsStream = readline.createInterface({
  input: blast.stdout,
})

blastResultsStream.on('line', line => {
  const QUERY = 0;
  const SEQ = 1;
  const LENGTH = 3;

  blastResultsStream.pause();
  alleleSizes.then(sizes => {
    const row = line.split('\t');
    if (Number(row[LENGTH]) > 0.8*Number(sizes[row[QUERY]])) {
      logger('good')(line);
    } else {
      logger('too short')(line);
    }
    blastResultsStream.resume();
  }).catch(() => {
    blastResultsStream.resume();
  });
})

setTimeout(() => {
  blastInputStream.end();
}, 3000);
