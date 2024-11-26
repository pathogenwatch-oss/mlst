const _ = require("lodash");
const es = require("event-stream");
const hasha = require("hasha");
const logger = require("debug");

const { createBlastProcess, parseBlastLine } = require("./blast");
const { fastaSlice, FastaString, reverseComplement } = require("./utils");

function streamFactory(allelePaths) {
	return (genes, start, end) => {
		const streams = _(genes)
			.map(gene => allelePaths[gene])
			.map(p => fastaSlice(p, start, end))
			.value();
		return es.merge(streams).pipe(new FastaString({
			highWaterMark: 10000
		}));
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
		return hasha(reverseComplement(closestMatchingSequence), {
			algorithm: "sha1"
		});
	}
	return hasha(closestMatchingSequence, { algorithm: "sha1" });
}

function determineSt(genes, alleles, profiles = {}, code, checksums) {
	// // First check for exact match
	if (code in profiles) {
		return profiles[code];
	}

	// Then iterate for partial matches (as some/most cgMLST profiles include "N" - indexed to Nan - in some positions)
	const queryProfile = code.split("_");
	for (const [ profileKey, st ] of Object.entries(profiles)) {
		const referenceProfile = profileKey.split("_");
		if (referenceProfile.length !== queryProfile.length) continue;
		let matched = true;

		for (let i = 0; i < referenceProfile.length; i++) {
			if (queryProfile[i] !== referenceProfile[i] && referenceProfile[i] !== "NaN") {
				matched = false;
				break;
			}
		}
		if (matched) return st;
	}
	// Finally return the hash of the checksums
	return hasha(checksums, { algorithm: "sha1" });
}

function hitOverlaps({ contigId, contigStart, contigEnd }, ranges, threshold = 300) {
	if (!(contigId in ranges)) return false;
	for (const range of ranges[contigId]) {
		if ((contigStart <= range.start && contigEnd >= range.start + threshold) || (contigStart <= range.end - threshold && contigEnd >= range.end)) {
			return true;
		}
	}
	return false;
}

function extendRanges(hit, ranges) {
	if (!(hit.contigId in ranges)) {
		ranges[hit.contigId] = [ { start: hit.contigStart, end: hit.contigEnd } ];
	} else {
		ranges[hit.contigId].push({ start: hit.contigStart, end: hit.contigEnd });
	}
}

function cleanExactHits(hits) {
	const sortedHits = hits.sort((a, b) => a.st - b.st);
	const selectedHits = [];
	const seenLoci = new Set();
	const ranges = {};
	for (const hit of sortedHits) {
		if (seenLoci.has(hit.gene)) continue;
		if (hitOverlaps(hit, ranges)) continue;
		seenLoci.add(hit.gene);
		extendRanges(hit, ranges);
		selectedHits.push(hit);
	}
	return selectedHits;
}

function integrateHits(newHits, currentHits = []) {

	const sortedHits = newHits.sort((a, b) => {
		if (a.pident === b.pident) {
			if (a.alleleLength === b.alleleLength) {
				return a.st - b.st;
			}
			return b.alleleLength - a.alleleLength;
		}
		return b.pident - a.pident;
	});

	const selectedHits = currentHits;
	const seenLoci = new Set(currentHits.map(hit => hit.gene));
	const ranges = {};
	currentHits.forEach(hit => extendRanges(hit, ranges));

	// const paralogHits = [];
// Deal with the single match families first
	for (const hit of sortedHits) {
		if (seenLoci.has(hit.gene)) continue;
		if (hitOverlaps(hit, ranges)) continue;
		seenLoci.add(hit.gene);
		extendRanges(hit, ranges);
		selectedHits.push(hit);
	}

	return selectedHits;
}

function formatOutput({ metadata, alleleMetadata, renamedSequences, bestHits }) {
	/* eslint-disable no-param-reassign */
	_.forEach(bestHits, hit => {
		// Add an id to all hits
		const { exact, st } = hit;
		hit.checksum = hit.checksum || hashHit(hit, renamedSequences);
		if (exact) hit.id = st; else hit.id = hit.checksum;

		// Set start and end
		const { reverse, contigStart, contigEnd } = hit;
		hit.start = reverse ? contigEnd : contigStart;
		hit.end = reverse ? contigStart : contigEnd;
	});

	const genes = alleleMetadata.genes;

	const alleles = bestHits.reduce((previous, current) => {
		if (current.gene in previous) {
			console.log(`Duplicate hit for gene ${current.gene}:\nOriginal:\n${JSON.stringify(current)}New:\n${JSON.stringify(previous[current.gene])}`);
		}
		previous[current.gene] = current;
		return previous;
	}, {});

	const code = genes.map(gene => alleles[gene] || { id: "" }).map(hit => hit.id).join("_");
	const checksums = genes.map(gene => alleles[gene] || { checksum: "" }).map(hit => hit.checksum);
	const rawCode = checksums.join("_");

	const st = determineSt(genes, alleles, alleleMetadata.profiles, code, checksums);

	const { host, type, schemeName, hostPath = "", schemeId = ""  } = metadata;
	const { shortname: scheme, schemeSize } = alleleMetadata;
	return {
		alleles, code, raw_code: rawCode, st, genes, scheme, schemeName, host, hostPath, schemeId, type, schemeSize
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
			st, alleleStart, alleleEnd, contigLength, contigStart, contigEnd, contigId, gene, matchingBases, pident
		} = hit;
		hit.exact = // eslint-disable-line no-param-reassign
			contigLength === this.alleleLengths[gene][st] && contigLength === matchingBases;
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
				return currentBestHit.matchingBases > hit.matchingBases ? currentBestHit : hit;
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
		return true;
	}

	// eslint-disable-next-line max-params
	getBin(gene, contigStart, contigEnd, contigId) {
		const existingBin = _.find(this._bins, bin => {
			if (bin.gene !== gene) return false;
			if (bin.contigId !== contigId) return false;
			// Check if the new hit is completely within the bin
			if (bin.contigStart <= contigStart && bin.contigEnd >= contigEnd) return true;
			// Check if the bin is completely within the new hit
			if (contigStart <= bin.contigStart && contigEnd >= bin.contigEnd) return true;
			const binLength = bin.contigEnd - bin.contigStart;
			// Check if the bin overlaps to the left
			if (bin.contigStart <= contigStart && bin.contigEnd <= contigEnd && bin.contigEnd > contigStart) {
				const overlap = (bin.contigEnd - contigStart) / binLength;
				return overlap > 0.8;
			}
			// Check if the new entry overlaps to the left
			if (contigStart <= bin.contigStart && contigEnd <= bin.contigEnd && contigEnd > bin.contigStart) {
				const overlap = (contigEnd - bin.contigStart) / binLength;
				return overlap > 0.8;
			}
			return false;
		});
		if (existingBin) {
			return existingBin;
		}
		const newBin = {
			gene, contigStart, contigEnd, contigId, hits: [], bestPIdent: 0
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
		bin.contigStart = bin.contigStart < hit.contigStart ? bin.contigStart : hit.contigStart;
		bin.contigEnd = bin.contigEnd > hit.contigEnd ? bin.contigEnd : hit.contigEnd;

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
	cleanExactHits, streamFactory, findGenesWithInexactResults, formatOutput, integrateHits, HitsStore
};
