const { test } = require("ava");
const logger = require("debug");
const _ = require("lodash");

const { Scheme } = require("../src/mlst-database");

test("Sort seq objects", t => {
  const seqs = [
    { st: 2, length: 10 },
    { st: 4, length: 8 },
    { st: 1, length: 8 },
    { st: 3, length: 12 },
    { st: 5, length: 10 },
  ];
  const expected = [
    { st: 3, length: 12 },
    { st: 2, length: 10 },
    { st: 1, length: 8 },
    { st: 5, length: 10 },    
    { st: 4, length: 8 },
  ];
  const actual = new Scheme({}).sort(seqs);
  t.deepEqual(actual, expected)
})
