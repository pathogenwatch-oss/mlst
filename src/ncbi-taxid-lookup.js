const _ = require("lodash");
const logger = require("debug");
const es = require("event-stream");
const fs = require("fs");
const tar = require("tar");

const { DeferredPromise } = require("./utils");
const { urlToPath } = require("../schemes/download-databases");

const TAXDUMP_HOST = "ftp.ncbi.nih.gov";
const TAXDUMP_REMOTE_PATH = "/pub/taxonomy/taxdump.tar.gz";

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

  const taxIDSpeciesStreamInput = es.split();
  const taxIDSpeciesStreamOutput = taxIDSpeciesStreamInput.pipe(
    // eslint-disable-next-line array-callback-return
    es.map((line, callback) => {
      const row = _(line).split("|").map(_.trim).value();
      const [taxid, species, __, rowType] = row.slice(0, 4); // eslint-disable-line no-unused-vars
      if (
        _.includes(
          ["equivalent name", "genbank synonym", "scientific name", "synonym"],
          rowType
        )
      ) {
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

function mapSpeciesToTaxids(taxIdSpeciesList) {
  logger("debug:mapSpeciesToTaxid")(
    `Looking for duplicates among ${taxIdSpeciesList.length} species`
  );
  const speciesTaxidMap = {};

  _.forEach(taxIdSpeciesList, ([taxId, species]) => {
    (speciesTaxidMap[species] = speciesTaxidMap[species] || []).push(taxId);
  });

  return speciesTaxidMap;
}

function loadSpeciesTaxidMap() {
  const taxdumpUrl = `ftp://${TAXDUMP_HOST}${TAXDUMP_REMOTE_PATH}`;
  const taxdumpPath = urlToPath(taxdumpUrl);
  const taxdumpStream = fs.createReadStream(taxdumpPath);
  const speciesTaxIdsMap = extractNcbiNamesFile(taxdumpStream)
    .then(parseNcbiNamesFile)
    .then(mapSpeciesToTaxids);
  return speciesTaxIdsMap;
}

module.exports = { loadSpeciesTaxidMap };
