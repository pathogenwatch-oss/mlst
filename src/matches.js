const _ = require("lodash");
const hasha = require("hasha");

const { reverseCompliment } = require("./utils");

function hashHit(hit, renamedSequences) {
  const { contigStart, contigEnd, contigId, hash, exact, reverse } = hit;
  if (hash || exact) return hit;
  const sequence = renamedSequences[contigId].toLowerCase();
  const closestMatchingSequence = sequence.slice(contigStart - 1, contigEnd);
  /* eslint-disable no-param-reassign */
  if (reverse) {
    hit.hash = hasha(reverseCompliment(closestMatchingSequence), {
      algorithm: "sha1"
    });
  } else {
    hit.hash = hasha(closestMatchingSequence, { algorithm: "sha1" });
  }
  /* eslint-enable no-param-reassign */
  return hit;
}

class HitsStore {
  constructor(alleleLengths, contigNameMap) {
    this.alleleLengths = alleleLengths;
    this.contigNameMap = contigNameMap;
    this._bins = [];
  }

  add(hit) {
    // Alleles of a given gene are similar (and sometimes truncations of one another)
    // We use "bins" to define a section of each query contig for each gene and add 
    // hits to each bin.  We can then select the best hit according so some criteria.
    // This means that we only count one hit for a given query contig but we can 
    // report multiple (different) hits as long as they're in different parts of the
    // query sequence.

    const {
      st,
      contigLength,
      contigStart,
      contigEnd,
      contigId,
      gene,
      matchingBases,
      pident
    } = hit;
    hit.exact = // eslint-disable-line no-param-reassign
      contigLength === this.alleleLengths[gene][st] &&
      contigLength === matchingBases;
    if (!this.longEnough(gene, st, contigLength)) return false;
    const bin = this.getBin(gene, contigStart, contigEnd, contigId);
    if (!this.closeEnough(pident, bin)) return false;
    if (bin.exact && !hit.exact) return false;
    this.updateBin(bin, hit);
    return true;
  }

  best() {
    return _.map(this._bins, bin => {
      const bestHit = _.reduce(bin.hits, (currentBestHit, hit) => {
        if (currentBestHit.matchingBases === hit.matchingBases) {
          return currentBestHit.pident > hit.pident ? currentBestHit : hit;
        }
        return currentBestHit.matchingBases > hit.matchingBases
          ? currentBestHit
          : hit;
      });
      bestHit.alleleLength = this.alleleLengths[bin.gene][bestHit.st];
      bestHit.contig = bestHit.contig || this.contigNameMap[bestHit.contigId];
      return bestHit;
    });
  }

  longEnough(gene, st, contigLength) {
    return contigLength >= this.alleleLengths[gene][st] * 0.8;
  }

  // eslint-disable-next-line max-params
  getBin(gene, contigStart, contigEnd, contigId) {
    const existingBin = _.find(this._bins, bin => {
      if (bin.gene !== gene) return false;
      if (bin.contigId !== contigId) return false;
      // Check if the new hit is completely within the bin
      if (bin.contigStart <= contigStart && bin.contigEnd >= contigEnd)
        return true;
      // Check if the bin is completely within the new hit
      if (contigStart <= bin.contigStart && contigEnd >= bin.contigEnd)
        return true;
      const binLength = bin.contigEnd - bin.contigStart;
      // Check if the bin overlaps to the left
      if (
        bin.contigStart <= contigStart &&
        bin.contigEnd <= contigEnd &&
        bin.contigEnd > contigStart
      ) {
        const overlap = (bin.contigEnd - contigStart) / binLength;
        return overlap > 0.8;
      }
      // Check if the new entry overlaps to the left
      if (
        contigStart <= bin.contigStart &&
        contigEnd <= bin.contigEnd &&
        contigEnd > bin.contigStart
      ) {
        const overlap = (contigEnd - bin.contigStart) / binLength;
        return overlap > 0.8;
      }
      return false;
    });
    if (existingBin) {
      return existingBin;
    }
    const newBin = {
      gene,
      contigStart,
      contigEnd,
      contigId,
      hits: [],
      bestPIdent: 0
    };
    this._bins.push(newBin);
    return newBin;
  }

  closeEnough(pident, bin) {
    return pident >= bin.bestPIdent - 2.0;
  }

  sameLocationButWorse(hitA, hitB) {
    // Fail if the hit isn't in the right place
    if (hitA.contigId !== hitB.contigId) return false;
    if (hitA.contigStart !== hitB.contigStart) return false;
    if (hitA.contigEnd !== hitB.contigEnd) return false;
    // A is a worse hit than B
    if (hitA.matchingBases < hitB.matchingBases) return true;
    // B matches the whole allele, which is better than a partial match
    if (hitA.matchingBases === hitB.matchingBases && hitB.exact) return true;
    return false;
  }

  updateBin(bin, hit) {
    /* eslint-disable no-param-reassign */
    bin.contigStart =
      bin.contigStart < hit.contigStart ? bin.contigStart : hit.contigStart;
    bin.contigEnd =
      bin.contigEnd > hit.contigEnd ? bin.contigEnd : hit.contigEnd;

    // If a bin has a exact hit in it, we're only interested in other
    // exact hits.
    if (hit.exact && !bin.exact) {
      bin.exact = true;
      _.remove(bin.hits, h => !h.exact);
    }

    if (hit.pident > bin.bestPIdent) {
      // Remove any hits which are no longer good enough
      bin.bestPIdent = hit.pident;
      _.remove(bin.hits, h => !this.closeEnough(h.pident, bin));
    }

    // Check if any of the existing hits should be replaced with the new one
    _.remove(bin.hits, h => this.sameLocationButWorse(h, hit));

    // Check if any of the existing hits is better than this new one
    if (_.find(bin.hits, h => this.sameLocationButWorse(hit, h))) return;

    bin.hits.push(hit);
    /* eslint-enable no-param-reassign */
  }
}

module.exports = { hashHit, HitsStore };
