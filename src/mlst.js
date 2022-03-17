const _ = require("lodash");
const es = require("event-stream");
const hasha = require("hasha");
const logger = require("debug");

const { createBlastProcess, parseBlastLine } = require("./blast");
const { fastaSlice, FastaString, reverseCompliment } = require("./utils");

function streamFactory(allelePaths) {
  return (genes, start, end) => {
    const streams = _(genes)
      .map(gene => allelePaths[gene])
      .map(p => fastaSlice(p, start, end))
      .value();
    return es.merge(streams).pipe(
      new FastaString({
        highWaterMark: 10000
      })
    );
  };
}

function findGenesWithInexactResults(bestHits) {
  return _(bestHits)
    .filter(({ exact }) => !exact)
    .map("gene")
    .uniq()
    .value();
}

function hashHit(hit, renamedSequences) {
  const { contigStart, contigEnd, contigId, hash, reverse } = hit;
  if (hash) return hash;
  const sequence = renamedSequences[contigId].toLowerCase();
  const closestMatchingSequence = sequence.slice(contigStart - 1, contigEnd);
  if (reverse) {
    return hasha(reverseCompliment(closestMatchingSequence), {
      algorithm: "sha1"
    });
  }
  return hasha(closestMatchingSequence, { algorithm: "sha1" });
}

function determineSt(genes, alleles, { profiles = {} }) {
  // Some species are expected to have multiple copies of
  // a locus (e.g. gono has 4 copies of 23s). With long read
  // data this shows up in `code` but the profiles only
  // report one copy.  The lookup should therefore needs
  // to deduplicate alleles but we'll keep it in the
  // output so that you can see all X were found
  const queryProfile = _(genes)
    .map(gene => alleles[gene] || [])
    .map(hits => _.map(hits, "id"))
    .map(hits => [ ...new Set(hits) ].sort())
    .map(hits => hits.join(","))
    .value();

  // First check for exact match
  const profileLookup = queryProfile
    .join("_")
    .toLowerCase();

  if (profileLookup in profiles) {
    return profiles[profileLookup];
  }

  // Then iterate for partial matches (as some/most cgMLST profiles include "N" - indexed to Nan - in some positions)
  for (const [ profileKey, st ] of Object.entries(profiles)) {
    const referenceProfile = profileKey.split('_');
    if (referenceProfile.length !== queryProfile.length) continue;
    let matched = true;

    for (let i = 0; i < referenceProfile.length; i++) {
      if (queryProfile[i] !== referenceProfile[i] && referenceProfile[i] !== 'NaN') {
        matched = false;
        break;
      }
    }
    if (matched) return st;
  }

  // Generate the hash code as no match.
  // This is like code but sorts the genes for
  // consistent hashing.  This is important so
  // that novel STs remain consistent. I've deduplicated
  // identical copies so that long and short read data
  // are more likely to get the same unique hash
  const sortedCode = _(genes)
    .sortBy()
    .map(gene => alleles[gene] || [])
    .map(hits => _.map(hits, "id"))
    .map(hits => [ ...new Set(hits) ].sort())
    .map(hits => hits.join(","))
    .value()
    .join("_")
    .toLowerCase();

  return hasha(sortedCode, { algorithm: "sha1" });
}

function formatOutput({ alleleMetadata, renamedSequences, bestHits }) {
  /* eslint-disable no-param-reassign */
  _.forEach(bestHits, hit => {
    // Add an id to all hits
    const { exact, st } = hit;
    if (exact) hit.id = st;
    else hit.id = hashHit(hit, renamedSequences);

    // Set start and end
    const { reverse, contigStart, contigEnd } = hit;
    hit.start = reverse ? contigEnd : contigStart;
    hit.end = reverse ? contigStart : contigEnd;
  });
  /* eslint-enable no-param-reassign */

  const { genes } = alleleMetadata;
  const alleles = _(bestHits)
    .groupBy("gene")
    .mapValues(hits =>
      _.sortBy(hits, [ ({ id }) => String(id), "contig", "start" ])
    )
    .value();
  _.forEach(genes, gene => {
    alleles[gene] = alleles[gene] || [];
  });

  // For each gene we make a comma delimited list of allele ids
  // and join them with underscores
  const code = _(genes)
    .map(gene => alleles[gene] || [])
    .map(hits => _.map(hits, "id").join(","))
    .value()
    .join("_")
    .toLowerCase();

  const st = determineSt(genes, alleles, alleleMetadata);

  const { shortname: scheme, schemeSize, url } = alleleMetadata;
  return {
    alleles,
    code,
    st,
    scheme,
    url,
    genes,
    schemeSize
  };
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
      alleleStart,
      alleleEnd,
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
    if (alleleStart === 1 && alleleEnd !== this.alleleLengths[gene][st]) {
      return false;
    }
    const bin = this.getBin(gene, contigStart, contigEnd, contigId);
    if (!this.closeEnough(pident, bin)) return false;
    if (bin.exact && !hit.exact) return false;
    this.updateBin(bin, hit);
    return true;
  }

  async addFromBlast(options) {
    const { stream, blastDb, wordSize, pIdent } = options;
    const [ blast, blastExit ] = createBlastProcess(blastDb, wordSize, pIdent);
    logger("cgps:debug:startBlast")(`About to blast genes against ${blastDb}`);

    const blastResultsStream = blast.stdout.pipe(es.split());
    blastResultsStream.on("data", line => {
      if (line === "") return;
      const hit = parseBlastLine(line);
      if (this.add(hit)) {
        logger("cgps:trace:mlst:addedHit")(line);
      } else {
        logger("cgps:trace:mlst:skippedHit")(line);
      }
    });

    stream.pipe(blast.stdin);
    await blastExit;
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
    const normalLength = this.alleleLengths[gene][st];
    if (contigLength < 0.8 * normalLength) return false;
    if (contigLength > 1.1 * normalLength) return false;
    return true
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

module.exports = {
  streamFactory,
  findGenesWithInexactResults,
  formatOutput,
  HitsStore
};
