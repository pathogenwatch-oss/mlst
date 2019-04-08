const { test } = require("ava");
const fs = require("fs");
const path = require("path");
const _ = require("lodash");
// const logger = require("debug");

const { findExactHits } = require("../src/exactHits");
const { loadSequencesFromStream } = require("../src/utils");

const alleleLookup = {
  ttattaatccaacaagctaa: [
    ["arcC", 1, 456, "b40d52e1523ad315e912c14030c8762a4a0b8513", false],
    ["arcC", 2, 456, "421f375084df5093bb1b341292672def82aa9da9", false]
  ],
  cgcttcaacaccttcatagg: [
    ["arcC", 1, 456, "a46651fa656672f714662530f430a403c6fcd58c", true],
    ["arcC", 2, 456, "db4a53b847fb47c4e8169204546a191616073ebe", true]
  ],
  ggtgctgattggattgtcat: [
    ["glpF", 1, 465, "dba3d89736daac1b48f0ef49ab2de83fdd9dcd6f", false],
    ["glpF", 2, 465, "5f84ebe96289fad803cdece80507a3d29af3358d", false]
  ],
  acgtgctgggttgattgcat: [
    ["glpF", 1, 465, "4b6ac029770d6405d21c365d81eb0ce175fd4583", true],
    ["glpF", 2, 465, "5ba7509e407dd53024153a0a707526c5cae6c3ce", true]
  ],
  aattttaattctttaggatt: [
    ["aroE", 1, 456, "2879e4bd88e631b0dec8265574516b19e3e0a782", false],
    ["aroE", 2, 456, "b37a0019b85ecead64112a8d3fdedefae840e744", false]
  ],
  taaatacttttcagcatctg: [
    ["aroE", 1, 456, "1b4bfe2eda47090da7610684e111e43fd7f37c3a", true],
    ["aroE", 2, 456, "b195fcf84eaa41e8bc83eb1a1e8797dcf8066ff5", true]
  ],
  cacgaaacagatgaagaaat: [
    ["tpi", 1, 402, "d15c89d005fe96b10a90c9de8918a8eb86297177", false],
    ["tpi", 2, 402, "e79e33c6326e40887bab53d157c3b31bed67ff0f", false]
  ],
  tgcgccacctactaatgccc: [
    ["tpi", 1, 402, "953140e2568a4571194d6c540088dc12bc999558", true],
    ["tpi", 2, 402, "49440a221ffc7112935340118c8fd765191a26ac", true]
  ],
  gcgtttaaagacgtgccagc: [
    ["yqiL", 1, 516, "42fb57d8a360dcb6a948348bf3608da5bf662847", false],
    ["yqiL", 2, 516, "e154f1d8de0fd8146bed37d81caa96aa1cb0c0b2", false]
  ],
  ttgctgtgcacgtactgctt: [
    ["yqiL", 1, 516, "3f0ff30930d4681fe766423f7f68716b58a73bd1", true],
    ["yqiL", 2, 516, "754b5ace1dc1219a49e0707e57276736707ab7a8", true]
  ],
  gcaacacaattacaagcaac: [
    ["pta", 1, 474, "08969ddac8d88396b04929069eabac5f8f8123e1", false],
    ["pta", 2, 474, "086e0ae1c184d175df887464e28d86fbaf15e1e6", false]
  ],
  taatgctgattttgcacttt: [
    ["pta", 1, 474, "a9cff972ded484f84568dab9a114870b4720a874", true],
    ["pta", 2, 474, "796a4a3ff47ad4bdcc4a48c719280e28292d492e", true]
  ],
  cgaatatttgaagatccaag: [
    ["gmk", 1, 417, "f4cf84c3f4bbe71af165ab0a68eea8f0068a80d9", false],
    ["gmk", 2, 417, "ab89721fe69015b880e337a078c5b86d149f1eaa", false]
  ],
  taaattcatcatttcaactt: [
    ["gmk", 1, 417, "1117330904e6ac6a75a743b0a2cf16946ab9ff72", true],
    ["gmk", 4, 417, "8fcccdf7a46b55f80b7aa98cc2cdd38a786e5467", true]
  ]
};

test("Find some ones", async t => {
  const testPath = path.join(
    __dirname,
    "testdata",
    "saureus_synthetic_ones.fasta"
  );
  const testStream = fs.createReadStream(testPath);
  const sequences = await loadSequencesFromStream(testStream);

  const hits = findExactHits(sequences, alleleLookup, 20);
  t.is(hits.length, 7);

  const expectedAlleles = [
    "arcC_1",
    "glpF_1",
    "aroE_1",
    "tpi_1",
    "yqiL_1",
    "pta_1",
    "gmk_1"
  ].sort();
  const actualAlleles = _(hits)
    .map("allele")
    .sort()
    .value();
  t.deepEqual(actualAlleles, expectedAlleles);

  const expectedGenes = [
    "arcC",
    "glpF",
    "aroE",
    "tpi",
    "yqiL",
    "pta",
    "gmk"
  ].sort();
  const actualGenes = _(hits)
    .map("gene")
    .sort()
    .value();
  t.deepEqual(actualGenes, expectedGenes);

  _.forEach(hits, ({ gene, st }) =>
    t.is(st, 1, `Expected st of ${gene} to be 1`)
  );
  _.forEach(hits, ({ gene, reverse }) =>
    t.is(reverse, false, `Didn't expected ${gene} to be reversed`)
  );
});

test("Find some reversed ones", async t => {
  const testPath = path.join(
    __dirname,
    "testdata",
    "saureus_synthetic_ones_reversed.fasta"
  );
  const testStream = fs.createReadStream(testPath);
  const sequences = await loadSequencesFromStream(testStream);

  const hits = findExactHits(sequences, alleleLookup, 20);
  t.is(hits.length, 7);

  const expectedAlleles = [
    "arcC_1",
    "glpF_1",
    "aroE_1",
    "tpi_1",
    "yqiL_1",
    "pta_1",
    "gmk_1"
  ].sort();
  const actualAlleles = _(hits)
    .map("allele")
    .sort()
    .value();
  t.deepEqual(actualAlleles, expectedAlleles);

  const expectedGenes = [
    "arcC",
    "glpF",
    "aroE",
    "tpi",
    "yqiL",
    "pta",
    "gmk"
  ].sort();
  const actualGenes = _(hits)
    .map("gene")
    .sort()
    .value();
  t.deepEqual(actualGenes, expectedGenes);

  _.forEach(hits, ({ gene, st }) =>
    t.is(st, 1, `Expected st of ${gene} to be 1`)
  );
  _.forEach(hits, ({ gene, reverse }) =>
    t.is(reverse, true, `Expected ${gene} to be reversed`)
  );
});
