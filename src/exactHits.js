const _ = require("lodash");
const hasha = require("hasha");

function findExactHits(renamedSequences, alleleDictionary, alleleDb, prefixLength = 20) {

  const hits = [];
  _.forEach(_.toPairs(renamedSequences), ([ contigId, seq ]) => {
    const sequence = seq.toLowerCase();
    _.forEach(_.range(sequence.length - prefixLength), idx => {
      const prefix = sequence.slice(idx, idx + prefixLength);

      if (prefix in alleleDictionary) {
        // Look up allele set by prefix
        const hashes = {};
        _.forEach(Object.keys(alleleDictionary[prefix]), length => {
          const alleleLength = parseInt(length, 10);
          const possibleMatch = sequence.slice(idx, idx + alleleLength);
          const hash = hasha(possibleMatch, { algorithm: "sha1" });
          hashes[hash] = length;
        });
        // Extract rows from DB and add to hits.
        const hashKeys = Object.keys(hashes);
        const findAllele = alleleDb.prepare(`SELECT hash, gene, st, reverse FROM alleles WHERE hash IN (${'?,'.repeat(hashKeys.length).slice(0,-1)})`);
        const matches = findAllele.all(...hashKeys);
        for (const { hash, gene, st, reverse } of matches) {
          const alleleLength = parseInt(hashes[hash], 10);
          hits.push({
            allele: `${gene}_${st}`,
            contigId,
            gene,
            st,
            alleleLength,
            pident: 100.0,
            contigStart: idx + 1,
            contigEnd: idx + alleleLength,
            contigLength: alleleLength,
            matchingBases: alleleLength,
            reverse
          });
        }
      }
    });
  });
  return hits;
}

module.exports.findExactHits = findExactHits;
