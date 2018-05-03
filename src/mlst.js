const _ = require("lodash");
const es = require("event-stream");
const hasha = require("hasha");
const logger = require("debug");

const { hashHit } = require("./matches");
const { createBlastProcess, parseBlastLine } = require("./blast");
const { fastaSlice, FastaString } = require("./utils");

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

async function runBlast(options = {}) {
  const { stream, blastDb, wordSize, pIdent, hitsStore } = options;
  const [blast, blastExit] = createBlastProcess(blastDb, wordSize, pIdent);
  logger("debug:startBlast")(`About to blast genes against ${blastDb}`);

  const blastResultsStream = blast.stdout.pipe(es.split());
  blastResultsStream.on("data", line => {
    if (line === "") return;
    const hit = parseBlastLine(line);
    if (hitsStore.add(hit)) {
      logger("trace:mlst:addedHit")(line);
    } else {
      logger("trace:mlst:skippedHit")(line);
    }
  });

  stream.pipe(blast.stdin);
  await blastExit;
  return options;
}

function buildResults(options) {
  const {
    bestHits,
    alleleLengths,
    genes,
    profiles,
    scheme,
    renamedSequences
  } = options;

  const alleles = _(genes)
    .map(gene => [gene, []])
    .fromPairs()
    .value();
  const raw = {};

  _.forEach(bestHits, hit => {
    const {
      contig,
      contigStart,
      contigEnd,
      contigLength,
      gene,
      hash,
      exact,
      reverse,
      st
    } = hashHit(hit, renamedSequences);
    const summary = {
      id: exact ? st : hash,
      contig,
      start: reverse ? contigEnd : contigStart,
      end: reverse ? contigStart : contigEnd
    };
    if (exact) {
      alleles[gene].push(summary);
    } else if (
      contigLength > 0.8 * alleleLengths[gene][st] &&
      contigLength < 1.1 * alleleLengths[gene][st]
    ) {
      alleles[gene].push(summary);
    }
    (raw[gene] = raw[gene] || []).push(hit);
  });

  const code = _.map(genes, gene => {
    const summaries = alleles[gene] || [];
    return _(summaries)
      .map(({ id }) => id)
      .value()
      .sort()
      .join(",");
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
  streamFactory,
  runBlast,
  buildResults
};
