const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const _ = require("lodash");

async function readJson(p) {
  const contents = await promisify(fs.readFile)(p);
  return JSON.parse(contents);
}

const TESTDATA_DIR = path.join(__dirname, "tests", "testdata");

function diff(as, bs) {
  const extra = [];
  const missing = _.clone(bs);
  _.forEach(as, a => {
    const idx = missing.indexOf(a);
    if (idx === -1) extra.push(a);
    else _.pullAt(missing, [idx]);
  });
  return { extra, missing };
}

function compareAlleles(actual, expected) {
  const { genes: expectedGenes, alleles: expectedAlleles } = expected;
  const { genes: actualGenes, alleles: actualAlleles } = actual;
  const badAlleles = {};
  const allGenes = _.union(expectedGenes, actualGenes);
  _.forEach(allGenes, gene => {
    const expectedHits = _.map(expectedAlleles[gene] || [], "id");
    const actualHits = _.map(actualAlleles[gene] || [], "id");
    const { extra, missing } = diff(actualHits, expectedHits);
    if (!_.isEmpty(_.concat(missing, extra))) {
      badAlleles[gene] = `+${extra.join(",")};-${missing.join(",")}`;
    }
  });
  return badAlleles;
}

module.exports = { readJson, TESTDATA_DIR, compareAlleles }
