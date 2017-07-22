const _ = require('lodash');
const { Transform, Readable } = require('stream');
const fasta = require('bionode-fasta');
const fs = require('fs');
const path = require('path');
const logger = require('debug');

// FASTA_DIR="/code/pubmlst/Staphylococcus_aureus/alleles";
MLST_DIR="/code/pubmlst"
SPECIES="Staphylococcus aureus"

function listAlleleFiles(species) {
  alleleDir=path.join(MLST_DIR, SPECIES.replace(' ', '_'), 'alleles');
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
    this.stream = fasta.obj(path);
    this.alleleSizes = {};
    this.wait = new Promise((resolve, reject) => {
      this.onMaxSeqs = resolve;
    });
    this.stream.on('data', seq => {
      logger('stream')(`Got ${seq.id} from ${path}`)
      count++;
      this.alleleSizes[seq.id] = seq.seq.length;
      if (this.maxSeqs > 0 && count >= this.maxSeqs) {
        logger('stream')(`Read ${count} from ${path}`);
        logger('stream')(this.alleleSizes);
        this.onMaxSeqs(this.alleleSizes);
        this.stream.pause();
      }
    });
    this.stream.on('close', () => {
      logger('stream')(`Finished reading from ${path}`)
      this.onMaxSeqs(this.alleleSizes);
    });
  }

  pipe(...options) {
    return this.stream.pipe(...options)
  }

  setMaxSeqs(maxSeqs) {
    if (maxSeqs > this.maxSeqs) {
      logger('wait')(`Increasing maxSeq from ${this.maxSeqs} to ${maxSeqs}`);
      this.maxSeqs = maxSeqs;
      this.wait = new Promise((resolve, reject) => {
        this.onMaxSeqs = resolve;
      });
      this.stream.resume();
    }
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

// const alleleStreams = listAlleleFiles(SPECIES).then(files => _.map(files, f => { return new AlleleStream(f, 5) }))
// const output = new FastaString();
// output.pipe(process.stdout);
// _.forEach(alleleStreams, s => { s.pipe(output) });
// Promise.all(_.map(alleleStreams, s => { return s.wait })).then(logger('counts'));

const alleleStream = listAlleleFiles(SPECIES).then(paths => { return new AlleleStream(paths[0], 10) });
// alleleStream.then(logger('debug'));
alleleStream.then(s => {
  s.wait.then(logger('counts'));
  // logger('debug')(s);
  s.pipe(new FastaString()).pipe(process.stdout);
  return s
}).then(s => {
  return new Promise((resolve, reject) => {
    logger('sleep')('Having a sleep');
    setTimeout(()=>resolve(s), 5000);
  })
}).then(s => {
  s.setMaxSeqs(20);
  return s.wait;
}).then(logger('counts:2'));
