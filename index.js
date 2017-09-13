#!/usr/bin/env node

const _ = require("lodash");
const logger = require("debug");

const { PubMlstSevenGenomeSchemes, BigsDbSchemes } = require("./src/mlst-database");
const { makeBlastDb } = require("./src/blast");
const { HitsStore } = require("./src/matches");
const {
  getAlleleStreams,
  startBlast,
  processBlastResultsStream,
  stopBlast,
  buildResults
} = require("./src/mlst");
const { findExactHits } = require("./src/exactHits")

const DATA_DIR = "/opt/mlst/databases";

const RUN_CORE_GENOME_MLST = (process.env.RUN_CORE_GENOME_MLST && true) || false;
let metadataSchemes;

if (RUN_CORE_GENOME_MLST) {
  metadataSchemes = new BigsDbSchemes(DATA_DIR);
} else {
  metadataSchemes = new PubMlstSevenGenomeSchemes(DATA_DIR)
}

const POSSIBLE_TAXID_ENVIRONMENT_VARIABLES = [
  "WGSA_ORGANISM_TAXID",
  "WGSA_SPECIES_TAXID",
  "WGSA_GENUS_TAXID"
];
let taxid;
let taxidVariableName;
let alleleMetadata;
_.forEach(POSSIBLE_TAXID_ENVIRONMENT_VARIABLES, variableName => {
  taxid = process.env[variableName] || null;
  alleleMetadata = metadataSchemes.read(taxid);
  if (alleleMetadata) {
    taxidVariableName = variableName;
    return false;
  }
  return true;
});

logger("params")({ taxidVariableName, taxid });

if (!alleleMetadata) {
  const taxIdEnvironmentVariables = _.zip(
    POSSIBLE_TAXID_ENVIRONMENT_VARIABLES,
    _.map(
      POSSIBLE_TAXID_ENVIRONMENT_VARIABLES,
      variable => process.env[variable]
    )
  );
  console.log(
    JSON.stringify({
      error: `Could not find MLST scheme:\n${JSON.stringify(
        taxIdEnvironmentVariables
      )}`
    })
  );
  process.exit(1);
}

const alleleLengths = alleleMetadata.lengths;
const {
  alleleLookup,
  alleleLookupPrefixLength,
  genes,
  profiles,
  allelePaths,
  scheme,
  commonGeneLengths,
  url
} = alleleMetadata;

const NUMBER_OF_ALLELES = 5;
const alleleStreams = getAlleleStreams(allelePaths, NUMBER_OF_ALLELES);

process.stdin.pause();
const { whenContigNameMap, whenRenamedSequences, whenBlastDb } = makeBlastDb(
  process.stdin
);
process.stdin.resume();
const whenExactHits = whenRenamedSequences.then(renamedSequences =>
  findExactHits(renamedSequences, alleleLookup, alleleLookupPrefixLength)
);

whenExactHits
  .then(hits => _.map(hits, ({ gene }) => gene))
  .then(matchedGenes => _.uniq(matchedGenes))
  .then(matchedGenes => logger("debug:exactHits")(`Found exact matches for ${matchedGenes.length} out of ${genes.length} genes`))

const whenHitsStore = whenContigNameMap.then(
  contigNameMap => new HitsStore(alleleLengths, contigNameMap)
);

const whenExactHitsAdded = Promise.all([whenHitsStore, whenExactHits]).then(([hitsStore, hits]) => {
  _.forEach(hits, hit => hitsStore.add(hit));
});

const whenFirstRunStreams = _.values(alleleStreams);

const whenFirstRunStart = Promise.all([whenFirstRunStreams, whenBlastDb, whenExactHitsAdded])
  .then(([streams, db]) => ({ streams, db, wordSize: 30, pIdent: 80 }))
  .then(startBlast);

const whenFirstRunProcessed = Promise.all([
  whenHitsStore,
  whenFirstRunStreams,
  whenFirstRunStart
])
  .then(([hitsStore, streams, { blast, blastResultsStream }]) => ({
    hitsStore,
    streams,
    blast,
    blastResultsStream
  }))
  .then(processBlastResultsStream);

const whenFirstRunStopped = Promise.all([
  whenFirstRunStart,
  whenFirstRunProcessed
])
  .then(([{ blast, blastInputStream }]) => ({ blast, blastInputStream }))
  .then(stopBlast);

const whenFirstRunResultCalculated = whenFirstRunStopped
  .then(() => Promise.all([whenHitsStore, whenRenamedSequences]))
  .then(([hitsStore, renamedSequences]) => {
    const bestHits = hitsStore.best();
    return {
      bestHits,
      alleleLengths,
      genes,
      profiles,
      scheme,
      commonGeneLengths,
      renamedSequences
    }
  })
  .then(buildResults)
  .catch(logger("error"));

whenFirstRunResultCalculated.then(results => {
  logger("hits:first")(results);
});

function findGenesWithImperfectResults(results) {
  const perfectResultFilter = ([, [firstMatch, ...otherMatches]]) => {
    const perfect =
      firstMatch && firstMatch.perfect && otherMatches.length === 0;
    return !perfect;
  };
  const imperfectGenes = _(results.raw)
    .toPairs()
    .filter(perfectResultFilter)
    .map(([gene]) => gene)
    .value();
  return imperfectGenes;
}

function getAlleleStreamsForGenes(imperfectGenes) {
  return _.map(imperfectGenes, gene => alleleStreams[gene]);
}

function updateAlleleStreamLimits(streams, limit) {
  return _.map(streams, stream => {
    stream.updateLimit(limit);
    return stream;
  });
}

const whenSecondRunStreams = whenFirstRunResultCalculated
  .then(findGenesWithImperfectResults)
  .then(imperfectGenes => {
    logger("debug:genes:secondRun")(`Rerunning blast on ${imperfectGenes.length} genes`);
    logger("trace:genes:secondRun")(imperfectGenes);
    return imperfectGenes;
  })
  .then(getAlleleStreamsForGenes)
  .then(alleleStreamsWithoutPerfectResults =>
    updateAlleleStreamLimits(alleleStreamsWithoutPerfectResults, 50)
  )
  .catch(logger("error"));

const whenSecondRunStart = Promise.all([whenSecondRunStreams, whenBlastDb])
  .then(([streams, db]) => ({ streams, db, wordSize: 20, pIdent: 80 }))
  .then(startBlast)
  .catch(logger("error"));

const whenSecondRunProcessed = Promise.all([
  whenHitsStore,
  whenSecondRunStreams,
  whenSecondRunStart
])
  .then(([hitsStore, streams, { blast, blastResultsStream }]) => ({
    hitsStore,
    streams,
    blast,
    blastResultsStream
  }))
  .then(processBlastResultsStream)
  .catch(logger("error"));

const whenSecondRunStopped = Promise.all([
  whenSecondRunStart,
  whenSecondRunProcessed
])
  .then(([{ blast, blastInputStream }]) => ({ blast, blastInputStream }))
  .then(stopBlast)
  .catch(logger("error"));

const whenSecondRunResultsCalculated = whenSecondRunStopped
  .then(() => Promise.all([whenHitsStore, whenRenamedSequences]))
  .then(([hitsStore, renamedSequences]) => {
    const bestHits = hitsStore.best();
    return {
      bestHits,
      alleleLengths,
      genes,
      profiles,
      scheme,
      commonGeneLengths,
      renamedSequences
    }
  })
  .then(buildResults)
  .catch(logger("error"));

whenSecondRunResultsCalculated.then(logger("hits:second"));

let whenFinalBlastResultsCalculated;
if (RUN_CORE_GENOME_MLST) {
  whenFinalBlastResultsCalculated = whenSecondRunResultsCalculated;
} else {
  // It would take too long to run Core Genome MLST using all of the
  // alleles so we skip this third run of Blast.
  const whenThirdRunStreams = whenSecondRunResultsCalculated
    .then(findGenesWithImperfectResults)
    .then(imperfectGenes => {
      logger("debug:thirdRunGenes")(imperfectGenes);
      return imperfectGenes;
    })
    .then(getAlleleStreamsForGenes)
    .then(alleleStreamsWithoutPerfectResults =>
      updateAlleleStreamLimits(alleleStreamsWithoutPerfectResults, null)
    )
    .catch(logger("error"));

  const whenThirdRunStarted = Promise.all([whenThirdRunStreams, whenBlastDb])
    .then(([streams, db]) => ({ streams, db, wordSize: 11, pIdent: 0 }))
    .then(startBlast)
    .catch(logger("error"));

  const whenThirdRunProcessed = Promise.all([
    whenHitsStore,
    whenThirdRunStreams,
    whenThirdRunStarted
  ])
    .then(([hitsStore, streams, { blast, blastResultsStream }]) => ({
      hitsStore,
      streams,
      blast,
      blastResultsStream
    }))
    .then(processBlastResultsStream)
    .catch(logger("error"));

  const whenThirdRunStopped = Promise.all([
    whenThirdRunStarted,
    whenThirdRunProcessed
  ])
    .then(([{ blast, blastInputStream }]) => ({ blast, blastInputStream }))
    .then(stopBlast)
    .catch(logger("error"));

  whenFinalBlastResultsCalculated = whenThirdRunStopped
    .then(() => Promise.all([whenHitsStore, whenRenamedSequences]))
    .then(([hitsStore, renamedSequences]) => {
      const bestHits = hitsStore.best();
      return {
        bestHits,
        alleleLengths,
        genes,
        profiles,
        scheme,
        commonGeneLengths,
        renamedSequences
      };
    })
    .then(buildResults)
    .catch(logger("error"));

  whenFinalBlastResultsCalculated.then(logger("hits:third"));
}

function formatOutput(results) {
  const { alleles, code, st } = results;
  return {
    alleles,
    code,
    st,
    scheme,
    url,
    genes
  };
}

Promise.all([whenFinalBlastResultsCalculated, whenHitsStore])
  .then(([results, hitsStore]) => {
    const output = formatOutput(results);
    if (process.env.DEBUG) {
      output.raw = results.raw;
      output.bins = hitsStore._bins;
    }
    return output;
  })
  .then(JSON.stringify)
  .then(console.log);
