'use strict';

const logger = require('debug');

const _ = require('lodash');
const { Duplex } = require('stream');

function pmap(promises, fn) {
  return _.map(promises, p => p.then(fn))
}

function splitResolveReject(promises) {
  const resolved = []
  const rejected = []

  const waiting = []

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
      })
  })

  return Promise.all(waiting)
    .then(() => ({resolved, rejected}))
}

class DeferredPromise {
  constructor(fn) {
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    })
  }

  then(fn) {
    return this.promise.then(fn)
  }

  catch(fn) {
    return this.promise.catch(fn)
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

class AsyncQueue {
  constructor(options={}) {
    this.contents = options.contents || [];
    this.consumerQueue = [];
    this.whenEmpty = new DeferredPromise().resolve(true);
  }

  push(el) {
    logger('trace:AsyncQueue')(`push:${this.contents.length}:${this.consumerQueue.length}`)
    const nextConsumer = this.consumerQueue.shift();
    if (typeof(nextConsumer) == 'undefined') {
      this.contents.push(el);
      if (this.contents.length == 1) {
        this.whenEmpty = new DeferredPromise();
      }
    } else {
      nextConsumer.resolve(el)
    }
  }

  shift() {
    logger('trace:AsyncQueue')(`shift:${this.contents.length}:${this.consumerQueue.length}`)
    const nextElement = this.contents.shift()
    const response = new DeferredPromise()
    if (typeof(nextElement) == 'undefined') {
      this.consumerQueue.push(response);
    } else {
      if (this.contents.length == 0) {
        this.whenEmpty.resolve(true);
      }
      response.resolve(nextElement);
    }
    return response;
  }

  length() {
    logger('trace:AsyncQueue')(`shift:${this.contents.length}:${this.consumerQueue.length}`)
    return this.contents.length;
  }
}


class ObjectTap extends Duplex {
  constructor(options={}) {
    options.objectMode = true;
    super(options);
    // this.name = options.name;
    this._buffer = new AsyncQueue();
    this.limit = options.limit || null;
    this._writeTokens = new AsyncQueue({contents: _.range(this.limit)});
  }

  whenFull() {
    return this._writeTokens.whenEmpty;
  }

  whenEmpty() {
    return this._buffer.whenEmpty;
  }

  _read() {
    logger('trace:ObjectTap')(`waiting to read from buffer of length ${this._buffer.length()}`)
    this._buffer.shift().then(el => {
      logger('trace:ObjectTap')(`read from buffer of length ${this._buffer.length()+1}`)
      this.push(el);
    });
  }

  _write(chunk, encoding, callback) {
    logger('trace:ObjectTap')(`waiting to write to buffer, ${this._writeTokens.length()} tokens remaining`)
    if (this.limit == null) {
      logger('trace:ObjectTap')('writing to unlimited buffer')
      this._buffer.push(chunk);
      callback();
    } else {
      this._writeTokens.shift().then(token => {
        logger('trace:ObjectTap')(`written ${token+1} total elements to the buffer`)
        this._buffer.push(chunk);
        if (token == null) {
          // Limits have been removed so push an empty token back
          this._writeTokens.push(token)
        }
        callback();
      });
    }
  }

  updateLimit(newLimit) {
    if (newLimit == null) {
      logger('trace:ObjectTap')(`removing write limit`)
      this.limit = null;
      this._writeTokens.push(null)
    } else if (this.limit == null) {
      logger('trace:ObjectTap')(`There are no limits to change`)
    } else if (newLimit > this.limit) {
      logger('trace:ObjectTap')(`adding ${newLimit - this.limit} write tokens`)
      for (var token=this.limit; token < newLimit; token++) {
        this._writeTokens.push(token);
      }
    } else {
      logger('trace:ObjectTap')(`Cannot reduce limit from ${this.limit} to ${newLimit}`)
    }
  }

  length() {
    return this._buffer.length();
  }
}

module.exports = { pmap, splitResolveReject, DeferredPromise, AsyncQueue, ObjectTap };
