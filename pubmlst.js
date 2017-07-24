'use strict';

const _ = require('lodash');
const { Transform, Readable } = require('stream');
const fasta = require('bionode-fasta');
const fs = require('fs');
const path = require('path');
const logger = require('debug');

const MLST_DIR="/code/pubmlst"

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
    this._stream.on('close', () => {
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

module.exports = { listAlleleFiles, AlleleStream, FastaString };
