const _ = require("lodash");
const hasha = require("hasha");

function findExactHits(renamedSequences, alleleLookup, prefixLength) {
  const hits = [];
  _.forEach(_.toPairs(renamedSequences), ([contigId, seq]) => {
    const sequence = seq.toLowerCase();
    _.forEach(_.range(sequence.length - prefixLength), idx => {
      const hashCache = {};
      const prefix = sequence.slice(idx, idx + prefixLength);
      const alleles = alleleLookup[prefix] || [];
      _.forEach(alleles, ([gene, st, alleleLength, alleleHash, reverse]) => {
        let hash = hashCache[alleleLength];
        if (!hash) {
          const possibleMatch = sequence.slice(idx, idx + alleleLength);
          hash = hasha(possibleMatch, { algorithm: "sha1" });
          hashCache[alleleLength] = hash;
        }
        if (hash === alleleHash) {
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
      });
    });
  });
  return hits;
}

module.exports.findExactHits = findExactHits;
