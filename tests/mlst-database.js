const { test } = require("ava");
const logger = require("debug");
const _ = require("lodash");

const { Scheme } = require("../src/mlst-database");

test("Sort seq objects", t => {
  const testCases = {
    lengths: {
      seqs: [
        { st: 0, length: 2 },
        { st: 0, length: 2 },
        { st: 0, length: 1 },
        { st: 0, length: 1 },
        { st: 0, length: 3 },
        { st: 0, length: 2 },
      ],
      expected: [
        { st: 0, length: 3 },
        { st: 0, length: 2 },
        { st: 0, length: 1 },
        { st: 0, length: 2 },
        { st: 0, length: 1 },
        { st: 0, length: 2 },
      ]
    },
    sts: {
      seqs: [
        { st: 3, length: 0 },
        { st: 2, length: 0 },
        { st: 1, length: 0 },
        { st: 4, length: 0 },
      ],
      expected: [
        { st: 1, length: 0 },
        { st: 2, length: 0 },
        { st: 3, length: 0 },
        { st: 4, length: 0 },
      ]
    },
    mix: {
      seqs: [
        { st: 2, length: 10 },
        { st: 4, length: 8 },
        { st: 1, length: 8 },
        { st: 3, length: 12 },
        { st: 5, length: 10 },
      ],
      expected: [
        { st: 3, length: 12 },
        { st: 2, length: 10 },
        { st: 1, length: 8 },
        { st: 5, length: 10 },
        { st: 4, length: 8 },
      ]
    }
  }
  const scheme = new Scheme({});
  _.forEach(testCases, ({ seqs, expected }, name) => {
    const actual = scheme.sort(seqs)
    t.deepEqual(actual, expected, name)
  })
})
