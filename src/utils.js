const logger = require("debug");
const fasta = require("bionode-fasta");
const fs = require("fs");
const through = require("through");

const _ = require("lodash");

function warn(title) {
  return logger(`warning:${title}`);
}

function fail(title) {
  return message => {
    logger(`error:${title}`)(message);
    process.exit(1);
  };
}

function pmap(promises, fn) {
  return _.map(promises, p => p.then(fn));
}

class DeferredPromise {
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

function splitResolveReject(promises) {
  const resolved = [];
  const rejected = [];

  const waiting = [];

  _.forEach(promises, p => {
    const waitingPromise = new DeferredPromise();
    waiting.push(waitingPromise);
    p
      .then(() => {
        resolved.push(p);
        waitingPromise.resolve();
      })
      .catch(() => {
        rejected.push(p);
        waitingPromise.resolve();
      });
  });

  return Promise.all(waiting).then(() => ({ resolved, rejected }));
}

function fastaSlice(path, start, end = 0) {
  let count = -1;
  const inputStream = fs.createReadStream(path);
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
  inputStream.pipe(fastaStream);
  return output;
}

function reverseCompliment(sequence) {
  return _(sequence.split(""))
    .reverse()
    .map(b => ({ t: "a", a: "t", c: "g", g: "c" }[b] || b))
    .value()
    .join("");
}

module.exports = {
  warn,
  fail,
  parseAlleleName,
  pmap,
  splitResolveReject,
  DeferredPromise,
  fastaSlice,
  loadSequencesFromStream,
  reverseCompliment
};
