'use strict';

const logger = require('debug');
const { Transform, Duplex } = require('stream');

class ObjectTap extends Duplex {
  constructor(limit=null, options={}) {
    options.objectMode = true;
    super(options)
    this.buffer = [];
    this.limit = limit;
    this.waitForLimitIncrease = new Promise((resolve, reject) => {
      this._onLimitIncrease = resolve;
    });
    this.waitForData = new Promise((resolve, reject) => {
      this._onNewData = resolve;
    });
    this.waitForPause = new Promise((resolve, reject) => {
      this._onPause = resolve;
    })
    this.count = 0;
  }

  _read() {
    var next;
    if (this.buffer.length == 0) {
      logger('read')('waiting')
      this.waitForData.then((_next) => {
        next = this.buffer.shift();
        logger('read:waited')(next);
        this.push(next);
      });
    } else {
      next = this.buffer.shift();
      logger('read:immediate')(next);
      this.push(next);
    }
  }

  addToBuffer(obj) {
    const bufferWasEmpty = (this.buffer.length == 0);

    this.buffer.push(obj);
    this.count += 1;

    if (bufferWasEmpty) {
      logger('add')('Buffer is no longer empty')
      const oldOnNewData = this._onNewData;
      this.waitForData = new Promise((resolve, reject) => {
        this._onNewData = resolve;
      });
      oldOnNewData();
    }
  }

  _write(chunk, encoding, callback) {
    const reachedLimit = (this.count >= this.limit);

    if (reachedLimit) {
      logger('write:wait')(chunk);
      const oldOnPause = this._onPause;
      this.waitForPause = new Promise((resolve, reject) => {
        this._onPause = resolve;
      })
      oldOnPause()
      this.waitForLimitIncrease.then(() => {
        this.addToBuffer(chunk)
        callback()
      });
    } else {
      logger('write:immediate')(chunk);
      this.addToBuffer(chunk);
      callback();
    }
  }

  updateLimit(newLimit) {
    if (newLimit <= this.limit) return;
    const previousOnLimitIncrease = this._onLimitIncrease;
    this.waitForLimitIncrease = new Promise((resolve, reject) => {
      this._onLimitIncrease = resolve;
    })
    this.limit = newLimit;
    previousOnLimitIncrease();
  }
}

module.exports = { ObjectTap };
