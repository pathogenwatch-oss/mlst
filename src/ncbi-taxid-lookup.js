const _ = require("lodash");
const logger = require("debug");
const es = require("event-stream");
const fs = require("fs");
const Client = require("ftp");
const tar = require("tar");

const { DeferredPromise } = require("./utils");

const TAXDUMP_HOST = "ftp.ncbi.nih.gov";
const TAXDUMP_REMOTE_PATH = "/pub/taxonomy/taxdump.tar.gz";

function ftpDownload(host, remotePath) {
  const output = new DeferredPromise();
  const ftp = new Client();
  ftp.on("ready", () => {
    logger("debug:download")(`Dowloading '${remotePath}' from ${host}`);
    ftp.get(remotePath, (err, stream) => {
      if (err) output.reject(err);
      stream.once("close", () => ftp.end());
      output.resolve(stream);
    });
  });
  ftp.connect({ host });
  return output;
}

// eslint-disable-next-line no-unused-vars
function fakeDownload(cachePath) {
  logger("debug:cached")(`Using cached 'taxdump.tar.gz' from '${cachePath}'`);
  const output = new DeferredPromise();
  logger("debug:fakeDownload")(`Waiting to 'download' ${cachePath}`);
  setTimeout(() => {
    logger("debug:fakeDownload")(`Waited for 'download' from ${cachePath}`);
    output.resolve(fs.createReadStream(cachePath));
  }, 120000);
  return output;
}

// eslint-disable-next-line no-unused-vars
function updateTaxDumpCache(cachePath, host, remotePath) {
  return ftpDownload(host, remotePath).then(stream => {
    const output = new DeferredPromise();
    const outfile = fs.createWriteStream(cachePath);
    stream.pipe(outfile);
    outfile.on("close", () => {
      logger("debug:download")(`Cached 'taxdump.tar.gz' to '${cachePath}'`);
      output.resolve(cachePath);
    });
    return output;
  });
}

function extractNcbiNamesFile(ftpStream) {
  const output = new DeferredPromise();
  const extractor = new tar.Parse({
    filter: path => {
      logger("trace:extractNcbiNamesFile:path")(path);
      if (path === "names.dmp") {
        return true;
      }
      return false;
    },
    onentry: entry => {
      output.resolve(entry);
    }
  });
  ftpStream.pipe(extractor);
  return output;
}

function parseNcbiNamesFile(namesFileStream) {
  const output = new DeferredPromise();
  const taxIdSpeciesMap = [];

  const taxIDSpeciesStreamInput = es.split()
  const taxIDSpeciesStreamOutput = taxIDSpeciesStreamInput.pipe(
    // eslint-disable-next-line array-callback-return
    es.map((line, callback) => {
      const row = _(line).split("|").map(_.trim).value();
      const [taxid, species, __, rowType] = row.slice(0, 4); // eslint-disable-line no-unused-vars
      if (rowType === "scientific name") {
        callback(null, [taxid, species]);
      } else {
        callback();
      }
    })
  );

  taxIDSpeciesStreamOutput.on("data", data => {
    taxIdSpeciesMap.push(data);
  });
  taxIDSpeciesStreamOutput.on("close", () => output.resolve(taxIdSpeciesMap));

  namesFileStream.pipe(taxIDSpeciesStreamInput);

  return output;
}

function mapTaxIdToSpecies(taxIdSpeciesList) {
  logger("debug:mapTaxIdToSpecies")(
    `Looking for duplicates among ${taxIdSpeciesList.length} species`
  );
  const taxIdsMap = {};

  _.forEach(taxIdSpeciesList, ([taxId, species]) => {
    if (taxIdsMap[taxId]) {
      throw new Error(`${species} and ${taxIdsMap[taxId]} both have TaxId '${taxId}'`);
    }
    taxIdsMap[taxId] = species;
  });

  return taxIdsMap;
}

function buildTaxidSpeciesMap(host, remotePath) {
  const download = ftpDownload(host, remotePath);
  // const download = fakeDownload("/tmp/names.tar.gz");
  // const download = updateTaxDumpCache('/tmp/names.tar.gz', host, remotePath).then(fakeDownload)
  const taxIdsSpeciesMap = download
    .then(extractNcbiNamesFile)
    .then(parseNcbiNamesFile)
    .then(mapTaxIdToSpecies);
  return taxIdsSpeciesMap;
}

module.exports = { buildTaxidSpeciesMap, TAXDUMP_HOST, TAXDUMP_REMOTE_PATH };
