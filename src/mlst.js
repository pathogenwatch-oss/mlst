const _ = require("lodash");
const es = require("event-stream");
const fasta = require("bionode-fasta");
const hasha = require("hasha");
const logger = require("debug");
const path = require("path");

const { hashHit } = require("./matches");
const { createBlastProcess, parseBlastLine } = require("./blast");
const { FastaString } = require("./mlst-database");
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

function makeBlastInputStream() {
  return new FastaString({
    highWaterMark: 10000
  });
}

function startBlast(options = {}) {
  const { streams, db, wordSize, pIdent } = options;

  const blast = createBlastProcess(db, wordSize, pIdent);
  const blastInputStream = makeBlastInputStream();
  blastInputStream.setMaxListeners(0);
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
    const hit = parseBlastLine(line);
    if (hitsStore.add(hit)) {
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
    commonGeneLengths,
    renamedSequences
  } = options;

  const alleles = _(genes).map(gene => [gene, []]).fromPairs().value();
  const raw = {};

  _.forEach(bestHits, hit => {
    const {
      allele,
      contig,
      contigStart,
      contigEnd,
      contigLength,
      gene,
      hash,
      exact,
      matchingBases,
      reverse,
      st
    } = hashHit(hit, renamedSequences);
    const modeGeneLength = Number(commonGeneLengths[gene]);
    const summary = {
      id: exact ? st : hash,
      contig,
      contigStart: reverse ? contigEnd : contigStart,
      contigEnd: reverse ? contigStart : contigEnd
    };
    if (exact) {
      alleles[gene].push(summary);
    } else if (
      contigLength > 0.8 * alleleLengths[allele] &&
      contigLength < 1.1 * alleleLengths[allele]
    ) {
      alleles[gene].push(summary);
    }
    (raw[gene] = raw[gene] || []).push(hit);
  });

  const code = _.map(genes, gene => {
    const summaries = alleles[gene] || [];
    return _(summaries).map(({ id }) => id).value().sort().join(",");
  })
    .join("_")
    .toLowerCase();

  const st = profiles[code]
    ? profiles[code]
    : hasha(code.toLowerCase(), { algorithm: "sha1" });

  return {
    alleles,
    code,
    raw,
    scheme,
    st
  };
}

module.exports = {
  getAlleleStreams,
  startBlast,
  processBlastResultsStream,
  stopBlast,
  buildResults
};
