const _ = require("lodash");
const es = require("event-stream");
const fasta = require("bionode-fasta");
const hasha = require("hasha");
const logger = require("debug");
const path = require("path");

const { createBlastProcess } = require("./blast");
const { parseAlleleName, FastaString } = require("./mlst-database");
const { ObjectTap, DeferredPromise } = require("./utils");

function getAlleleStreams(allelePaths, limit) {
  const streams = {};
  _.forEach(allelePaths, p => {
    const allele = path.basename(p, ".tfa");
    const objectLimiter = new ObjectTap({ limit });
    const stream = fasta.obj(p).pipe(objectLimiter);
    streams[allele] = stream;
  });
  return streams;
}

function addHashesToHits(sequences, hits) {
  logger("trace:hash")(`About to add hashes to ${hits.length} hits`);

  const compliment = b => ({ t: "a", a: "t", c: "g", g: "c" }[b] || b);

  const hashHit = (sequence, hit) => {
    const { start, end, reverse } = hit;
    let bases;
    if (reverse) {
      bases = _(sequence.toLowerCase())
        .slice(start - 1, end)
        .map(compliment)
        .reverse()
        .value()
        .join("");
    } else {
      bases = _(sequence.toLowerCase()).slice(start - 1, end).value().join("");
    }
    return hasha(bases, { algorithm: "sha1" });
  };

  const unhashedHits = [];
  _.forEach(hits, (hit, idx) => {
    const sequence = sequences[hit.sequenceId];
    if (!sequence) {
      unhashedHits.push(hit);
      return;
    }
    const hash = hashHit(sequence, hit);
    hit.hash = hash; // eslint-disable-line no-param-reassign
    logger("trace:hash")(`added hash '${hash}' to hit ${idx}`);
  });

  if (unhashedHits.length > 0) {
    const missingHitSequences = _.map(unhashedHits, hit => `* ${hit.sequence}`);
    logger("error")(
      `Couldn't find the following among the input sequences:\n${missingHitSequences.join(
        "\n"
      )}`
    );
    throw Error(`${unhashedHits.length} hits couldn't be hashed`);
  } else {
    logger("trace:hash")(`Finished adding hashes to hits`);
  }

  return hits;
}

function addMatchingAllelesToHits(alleleHashes, hits) {
  _.forEach(hits, hit => {
    const matchingAllele = alleleHashes[hit.hash];
    if (matchingAllele) {
      hit.matchingAllele = matchingAllele; // eslint-disable-line no-param-reassign
    }
  });
  return hits;
}

function makeBlastInputStream() {
  return new FastaString({
    highWaterMark: 10000
  });
}

function startBlast(options = {}) {
  const { streams, db, wordSize, pIdent } = options;

  const blast = createBlastProcess(db, wordSize, pIdent);
  const blastInputStream = makeBlastInputStream();
  _.forEach(streams, stream => {
    stream.pipe(blastInputStream);
  });

  blastInputStream.pipe(blast.stdin);
  const blastResultsStream = blast.stdout.pipe(es.split());

  return { blast, blastInputStream, blastResultsStream };
}

function processBlastResultsStream(options = {}) {
  const { hitsStore, streams, blastResultsStream } = options;

  blastResultsStream.on("data", line => {
    if (line === "") return;
    const hit = hitsStore.buildHit(line);
    if (hitsStore.update(hit)) {
      logger("trace:mlst:addedHit")(line);
    } else {
      logger("trace:mlst:skippedHit")(line);
    }
  });

  return Promise.all(_.map(streams, stream => stream.whenEmpty()));
}

function stopBlast(options = {}) {
  const { blast, blastInputStream } = options;
  const output = new DeferredPromise();

  blastInputStream.end();
  blast.on("exit", (code, signal) => {
    if (code !== 0) output.resolve(`Blast exited with ${code} (${signal})`);
    output.resolve(options);
  });

  return output;
}

function buildResults(options = {}) {
  const {
    bestHits,
    alleleLengths,
    genes,
    profiles,
    scheme,
    commonGeneLengths
  } = options;

  const hitToResult = hit => {
    const {
      sequence,
      start,
      end,
      reverse,
      gene,
      sequenceLength,
      hash,
      matchingAllele,
      matchingBases
    } = hit;
    const perfect =
      !!matchingAllele && sequenceLength === alleleLengths[matchingAllele];
    const allele = matchingAllele ? parseAlleleName(matchingAllele).st : null;
    const closestAllele = parseAlleleName(hit.allele).st;
    const closestAlleleLength = alleleLengths[hit.allele] || null;
    return {
      blastResult: {
        contig: sequence,
        start,
        end,
        reverse,
        matchingBases,
        closestAllele,
        closestAlleleLength: closestAlleleLength || null
      },
      perfect,
      length: sequenceLength,
      alleleLength: alleleLengths[matchingAllele] || null,
      hash,
      allele,
      modeGeneLength: Number(commonGeneLengths[gene])
    };
  };

  const alleles = _(genes).map(gene => [gene, []]).fromPairs().value();
  const raw = {};

  _.forEach(bestHits, hit => {
    const { gene } = hit;
    const result = hitToResult(hit);
    const { allele, hash, blastResult, length, modeGeneLength } = result;
    const { contig, start, end, reverse } = blastResult;
    const summary = {
      id: allele || hash,
      contig,
      start: reverse ? end : start,
      end: reverse ? start : end
    };
    if (allele) {
      alleles[gene].push(summary);
    } else if (
      blastResult.matchingBases > 0.8 * modeGeneLength &&
      length < 1.1 * modeGeneLength
    ) {
      alleles[gene].push(summary);
    }
    (raw[gene] = raw[gene] || []).push(result);
  });

  const results = {
    alleles,
    raw
  };

  const code = _.map(genes, gene => {
    const summaries = alleles[gene] || [];
    return _(summaries).map(summary => summary.id).value().sort().join(",");
  })
    .join("_")
    .toLowerCase();

  const st = profiles[code]
    ? profiles[code]
    : hasha(code.toLowerCase(), { algorithm: "sha1" });
  results.st = st;
  results.code = code;
  results.scheme = scheme;

  return results;
}

module.exports = {
  getAlleleStreams,
  addHashesToHits,
  addMatchingAllelesToHits,
  startBlast,
  processBlastResultsStream,
  stopBlast,
  buildResults
};
