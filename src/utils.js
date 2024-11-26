const logger = require("debug");
const fasta = require("bionode-fasta");
const fs = require("fs");
const { Transform } = require("stream");
const through = require("through");
const zlib = require("zlib");

const _ = require("lodash");

function warn(title) {
  return logger(`cgps:warning:${title}`);
}

function fail(title) {
  return message => {
    const content = `${new Date()}:fatal:${title}|${message}\n`;
    fs.writeSync(2, content);
    process.exit(1);
  };
}

class DeferredPromise {
  // WARNING: async doesn't like awaiting these; return this.promise from async functions
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  then(fn) {
    return this.promise.then(fn);
  }

  catch(fn) {
    return this.promise.catch(fn);
  }

  resolve(val) {
    this._resolve(val);
    return this;
  }

  reject(val) {
    this._reject(val);
    return this;
  }
}

function fastaSlice(path, start, end = 0) {
  let count = -1;
  const inputStream = fs.createReadStream(path).pipe(zlib.createGunzip());
  const outputStream = through(function write(data) {
    count += 1;
    if (end !== 0 && count >= end) this.queue(null);
    else if (count >= start) this.queue(data);
  });
  return inputStream.pipe(fasta.obj()).pipe(outputStream);
}

function loadSequencesFromStream(inputStream) {
  const fastaStream = fasta.obj();
  const output = new DeferredPromise();
  const sequences = {};
  fastaStream.on("data", ({ id, seq }) => {
    sequences[id] = seq;
  });
  fastaStream.on("end", () => output.resolve(sequences));
  fastaStream.on("error", err => output.reject(err));
  inputStream.pipe(fastaStream);
  return output.promise;
}

class FastaString extends Transform {
  constructor(options = {}) {
    super(_.assign(options, { objectMode: true }));
  }

  _transform(chunk, encoding, callback) {
    const output = `>${chunk.id}\n${chunk.seq}\n`;
    this.push(output);
    callback();
  }
}

function reverseComplement(sequence) {
  return _(sequence.split(""))
    .reverse()
    .map(b => ({ t: "a", a: "t", c: "g", g: "c" }[b] || b))
    .value()
    .join("");
}

module.exports = {
  warn,
  fail,
  FastaString,
  DeferredPromise,
  fastaSlice,
  loadSequencesFromStream,
  reverseComplement
};
