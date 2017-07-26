'use strict';

const logger = require('debug');

const _ = require('lodash');
const { Transform, Duplex } = require('stream');
const AsyncLock = require('async-lock');

class AsyncQueue {
  constructor(options={}) {
    this.buffer = options.buffer || [];
    this._lock = new AsyncLock();
    this._next = new Promise((resolve, reject) => {
      this._onNext = resolve;
    });
    this.onEmpty();
  }

  onEmpty() {
    const oldOnEmpty = this._onEmpty;
    this._empty = new Promise((resolve, reject) => {
      this._onEmpty = () => {
        logger('trace:AsyncQueue')('queue is empty');
        resolve();
      }
    });
    if (oldOnEmpty) return oldOnEmpty();
  }

  push(el) {
    logger('trace:AsyncQueue')(`pushing to queue of length ${this.buffer.length}`);
    if (this.buffer.length == 0) {
      const onNext = this._onNext;
      this._next = new Promise((resolve, reject) => {
        this._onNext = resolve;
      });
      this.buffer.push(el);
      onNext();
    } else {
      this.buffer.push(el);
    }
  }

  shift() {
    var onShift;
    const output = new Promise((resolve, reject) => {
      onShift = resolve;
    })
    if (this.buffer.length == 0) {
      logger('trace:AsyncQueue')(`waiting to shift from queue of ${this.buffer.length} elements`)
      this._lock.acquire('shift', (done) => {
        logger('trace:AsyncQueue')('at the front of the queue for new elements')
        this._next.then(() => {
          logger('trace:AsyncQueue')('there are new elements')
          const el = this.buffer.shift()
          if (this.buffer.length == 0) this.onEmpty()
          done(null, el)
        })
      }, (err, ret) => {
        logger('trace:AsyncQueue')('returning the newest element')
        onShift(ret)
      })
    } else {
      logger('trace:AsyncQueue')(`waiting to shift from queue of ${this.buffer.length} elements`)
      this._lock.acquire('shift', (done) => {
        logger('trace:AsyncQueue')('getting the newest element')
        const el = this.buffer.shift()
        if (this.buffer.length == 0) this.onEmpty()
        done(null, el)
      }, (err, ret) => {
        logger('trace:AsyncQueue')('returning the newest element');
        onShift(ret)
      })
    }
    return output
  }

  length() {
    return this.buffer.length;
  }

  whenEmpty() {
    return this._empty;
  }
}


class ObjectTap extends Duplex {
  constructor(options={}) {
    options.objectMode = true;
    super(options);
    // this.name = options.name;
    this._buffer = new AsyncQueue();
    this.limit = options.limit || null;
    this._writeTokens = new AsyncQueue({buffer: _.range(this.limit)});
  }

  whenFull() {
    return this._writeTokens.whenEmpty();
  }

  whenEmpty() {
    return this._buffer.whenEmpty();
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

module.exports = { AsyncQueue, ObjectTap };
