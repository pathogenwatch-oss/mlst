'use strict';

const _ = require('lodash');
const { Transform, Readable } = require('stream');
const fasta = require('bionode-fasta');
const fs = require('fs');
const path = require('path');
const logger = require('debug');
const hasha = require('hasha');

const MLST_DIR="/code/pubmlst"

function getAlleleHashes(species) {
  const hashPath=path.join(MLST_DIR, species.replace(' ', '_'), 'hashes');
  return require(hashPath);
}

function listAlleleFiles(species) {
  const alleleDir=path.join(MLST_DIR, species.replace(' ', '_'), 'alleles');
  return new Promise((resolve, reject) => {
    fs.readdir(alleleDir, (err, files) => {
      if (err) reject(err);
      const paths = _.map(files, f => {
        return path.join(alleleDir, f);
      });
      logger('paths')(paths)
      resolve(paths);
    });
  });
}

function hashAlleles(species) {
  const hashAlleleFile = (path) => {
    logger('debug')(`About to hash sequences in ${path}`)
    const listOfHashes = [];
    const seqStream = fasta.obj(path);
    seqStream.on('data', seq => {
      const allele = seq.id;
      const gene = allele.split('_')[0];
      // logger('trace')(`Hashing ${allele} from ${path}`)
      const hash = hasha(seq.seq.toLowerCase(), {algorithm: 'sha1'});
      const hashObj = {};
      hashObj[hash] = allele;
      listOfHashes.push(hashObj);
    });
    var onFinished;
    const output = new Promise((resolve, reject) => {
      onFinished = resolve;
    })
    seqStream.on('end', () => {
      logger('debug')(`Finished hashing ${listOfHashes.length} hashes from ${path}`)
      onFinished(listOfHashes);
    })
    return output;
  }
  return listAlleleFiles(species).then(paths => {
    return Promise.all(_.map(paths, p => {
      return hashAlleleFile(p)
    })).then(fileHashes => {
      const hashes = _.flatten(fileHashes);
      return _.merge(...hashes);
    });
  });
}

function writeAlleleHashes(path, species) {
  return hashAlleles(species).then(hashes => {
    const json = JSON.stringify(hashes);
    fs.writeFile(path, json, (err, data) => {
      if (err) logger('error')(err);
      logger('debug')(`Wrote ${_.keys(hashes).length} hashes to ${path}`)
    })
    return hashes;
  });
}

class AlleleStream {
  constructor(path, maxSeqs=0) {
    logger('stream')(`New from ${path}`);
    var count = 0;
    this.maxSeqs = maxSeqs;
    this._stream = fasta.obj(path);
    this._alleleSizes = {};
    this.alleleSizes = new Promise((resolve, reject) => {
      this.onMaxSeqs = resolve;
    });
    this._stream.on('data', seq => {
      logger('stream')(`Got ${seq.id} from ${path}`)
      count++;
      this._alleleSizes[seq.id] = seq.seq.length;
      if (this.maxSeqs > 0 && count >= this.maxSeqs) {
        logger('stream')(`Read ${count} from ${path}`);
        this.onMaxSeqs(this._alleleSizes);
        this._stream.pause();
      }
    });
    this._stream.on('end', () => {
      logger('stream')(`Finished reading from ${path}`)
      this.onMaxSeqs(this._alleleSizes);
    });
  }

  pipe(...options) {
    this._stream.pipe(...options);
  }

  setMaxSeqs(maxSeqs) {
    if (maxSeqs > this.maxSeqs) {
      logger('wait')(`Increasing maxSeq from ${this.maxSeqs} to ${maxSeqs}`);
      this.maxSeqs = maxSeqs;
      this.alleleSizes = new Promise((resolve, reject) => {
        this.onMaxSeqs = resolve;
      });
      this._stream.resume();
    }
    return this.alleleSizes;
  }
}

class FastaString extends Transform {
  constructor(options={}) {
    options.objectMode = true;
    super(options)
  }

  _transform(chunk, encoding, callback) {
    const output=`>${chunk.id}\n${chunk.seq}\n`;
    this.push(output);
    callback();
  }
}

module.exports = { listAlleleFiles, getAlleleHashes, AlleleStream, FastaString, writeAlleleHashes };
