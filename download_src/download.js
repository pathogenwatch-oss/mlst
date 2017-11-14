const axios = require("axios");
const logger = require("debug");
const fs = require("fs");
const Client = require("ftp");
const hasha = require("hasha");
const _ = require("lodash");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const { URL } = require("url");
const { promisify } = require("util");
const { parseString } = require("xml2js");

const readFileAsync = promisify(fs.readFile);

const PUBMLST_SEVEN_GENOMES_METADATA_URL =
  "https://pubmlst.org/data/dbases.xml";
const BIGSDB_SCHEME_METADATA_PATH = path.join(
  __dirname,
  "..",
  "bigsDb-schemes.json"
);
const TAXDUMP_HOST = "ftp.ncbi.nih.gov";
const TAXDUMP_REMOTE_PATH = "/pub/taxonomy/taxdump.tar.gz";

const CACHE_DIR = path.join(__dirname, 'scheme_cache');

function urlToPath(url) {
  const urlObj = new URL(url);
  const normalise = part => part.toLowerCase().replace(/[^a-z0-9.]+/g, "_");
  const hostnameBitOfPath = normalise(urlObj.hostname);
  const middleBitOfPath = _(urlObj.pathname)
    .split("/")
    .filter(el => el !== "")
    .map(normalise)
    .value();
  const searchHash = urlObj.search
    ? hasha(urlObj.search, { algorithm: "sha1" })
    : null;
  const searchSuffix = searchHash ? `-${searchHash}` : "";
  return path.join(CACHE_DIR, hostnameBitOfPath, ...middleBitOfPath) + searchSuffix;
}

async function createWriteStreamIfNotExists(outputPath) {
  const fd = await promisify(fs.open)(outputPath, "wx", 0o544);
  return fs.createWriteStream("", { fd });
}

function parseXml(content) {
  return new Promise((resolve, reject) => {
    parseString(content, (err, result) => {
      if (err) reject(err);
      resolve(result);
    });
  });
}

function delay(wait) {
  return new Promise(resolve => {
    setTimeout(resolve, wait);
  });
}

class SlowDownloader {
  constructor(minWait = 1000) {
    this.minWait = minWait; // ms
    this.nextRequestAllowed = Promise.resolve(null);
  }

  async get(...options) {
    let onOurRequestComplete;
    logger("trace:SlowDownloader")(`Queueing ${options[0]}`);
    const whenOurRequestComplete = new Promise(resolve => {
      onOurRequestComplete = resolve;
    });
    const earliestNextRequest = this.nextRequestAllowed.then(() =>
      delay(this.minWait)
    );
    const whenWeCanMakeRequest = this.nextRequestAllowed;
    this.nextRequestAllowed = Promise.all([
      earliestNextRequest,
      whenOurRequestComplete
    ]);
    await whenWeCanMakeRequest;
    const response = await axios.get(...options);
    onOurRequestComplete();
    return response;
  }

  async downloadFile(url, downloadPath) {
    const dirname = path.dirname(downloadPath);
    await mkdirp(dirname, { mode: 0o755 });
    try {
      // Don't start a download if we already have a copy of the file
      await promisify(fs.access)(downloadPath, fs.constants.F_OK);
      logger("trace:SlowDownloader")(
        `${downloadPath} already exists, skipping`
      );
      return downloadPath;
    } catch (err) {
      // File isn't already downloaded
    }
    const response = await this.get(url, { responseType: "stream" });
    let outstream;
    try {
      outstream = await createWriteStreamIfNotExists(downloadPath);
    } catch (err) {
      // Check file still doesn't exist after we've started downloading the data
      if (err.code === "EEXIST") {
        logger("trace:SlowDownloader")(
          `${downloadPath} already exists, skipping`
        );
        return downloadPath;
      }
      throw err;
    }
    const whenOutputFileClosed = new Promise(resolve => {
      outstream.on("close", () => {
        logger("trace:SlowDownloader")(`Written ${url} to ${downloadPath}`);
        resolve(downloadPath);
      });
    });
    response.data.pipe(outstream);
    return whenOutputFileClosed;
  }
}

const downloaders = {};
async function downloadFile(url) {
  const urlObj = new URL(url);
  if (!_.has(downloaders, urlObj.hostname)) {
    downloaders[urlObj.hostname] = new SlowDownloader(1000);
  }
  const downloader = downloaders[urlObj.hostname];
  const downloadPath = urlToPath(url);
  return await downloader.downloadFile(url, downloadPath);
}

function extractUrlsForPubMlstSevenGenes(metadata) {
  const speciesData = metadata.data.species;
  const getSpeciesUrls = data => {
    const database = data.mlst[0].database[0];
    const profiles = database.profiles[0];
    const profilesUrl = profiles.url[0];
    const lociUrls = _.map(database.loci[0].locus, locus => locus.url[0]);
    return [profilesUrl, ...lociUrls];
  };
  return _.flatMap(speciesData, getSpeciesUrls);
}

async function readJson(path) {
  const jsonString = await promisify(fs.readFile)(path);
  return JSON.parse(jsonString);
}

async function downloadPubMlstSevenGenes() {
  const metadataUrl = PUBMLST_SEVEN_GENOMES_METADATA_URL;
  const metadataPath = await downloadFile(metadataUrl);
  logger("tmp")(metadataPath);
  const metadataContent = await readFileAsync(metadataPath);
  const metadata = await parseXml(metadataContent);
  const urls = extractUrlsForPubMlstSevenGenes(metadata);
  const downloads = _.map(urls, async (url, idx) => {
    const downloadPath = await downloadFile(url);
    logger("trace:downloadPubMlstSevenGenes")(
      `Downloaded ${idx + 1} of ${urls.length} files`
    );
    return downloadPath;
  });
  const downloadPaths = await Promise.all(downloads);
  return [metadataPath, ...downloadPaths];
}

async function downloadBigsDbSchemes() {
  const schemeMetadata = await readJson(BIGSDB_SCHEME_METADATA_PATH);
  const schemeDetailsDownloads = _.map(
    schemeMetadata,
    async ({ url }) => await downloadFile(url)
  );
  const schemeDetails = _.map(
    schemeDetailsDownloads,
    async downloadPath => await readJson(await downloadPath)
  );
  const schemeAlleleUrls = _.map(schemeDetails, async schemeData =>
    _.map((await schemeData).loci, url => `${url}/alleles_fasta`)
  );
  const alleleUrls = _.flatten(await Promise.all(schemeAlleleUrls));
  const alleleDownloads = _.map(alleleUrls, async (url, idx) => {
    const downloadPath = await downloadFile(url);
    logger("trace:downloadBigsDbSchemes")(
      `Downloaded ${idx + 1} of ${alleleUrls.length} files`
    );
    return downloadPath;
  });
  const allelePaths = await Promise.all(alleleDownloads);
  const schemePaths = await Promise.all(schemeDetailsDownloads);
  return [...schemePaths, ...allelePaths];
}

async function downloadNcbiTaxDump() {
  const taxdumpUrl = `ftp://${TAXDUMP_HOST}${TAXDUMP_REMOTE_PATH}`;
  const taxdumpPath = urlToPath(taxdumpUrl);
  const dirname = path.dirname(taxdumpPath);
  await mkdirp(dirname, { mode: 0o755 });

  try {
    // Don't start a download if we already have a copy of the file
    await promisify(fs.access)(taxdumpPath, fs.constants.F_OK);
    logger("trace:SlowDownloader")(`${taxdumpPath} already exists, skipping`);
    return taxdumpPath;
  } catch (err) {
    // File isn't already downloaded
  }

  let onStreamingStart, onStreamError;
  const whenStreaming = new Promise((resolve, reject) => {
    onStreamingStart = resolve;
    onStreamError = reject;
  });

  const ftp = new Client();
  ftp.on("error", onStreamError);
  ftp.on("ready", () => {
    logger("debug:ftpDownload")(`Dowloading '${TAXDUMP_REMOTE_PATH}' from ${TAXDUMP_HOST}`);
    ftp.get(TAXDUMP_REMOTE_PATH, (err, stream) => {
      if (err) onStreamError(err);
      stream.once("close", () => ftp.end());
      onStreamingStart(stream);
    });
  });
  ftp.connect({ host: TAXDUMP_HOST });
  const taxdumpStream = await whenStreaming;

  let outstream;
  try {
    outstream = await createWriteStreamIfNotExists(taxdumpPath);
  } catch (err) {
    if (err.code === "EEXIST") {
      logger("trace:ftpDownload")(`${taxdumpPath} already exists, skipping`);
      return taxdumpPath;
    }
    throw err;
  }

  const whenDownloadComplete = new Promise(resolve => {
    outstream.on("close", () => {
      logger("debug:ftpDownload")(`Downloaded 'taxdump.tar.gz' to '${taxdumpPath}'`);
      resolve(taxdumpPath);
    });
  });
  taxdumpStream.pipe(outstream);
  return whenDownloadComplete;
}

module.exports = { urlToPath };

if (require.main === module) {
  downloadPubMlstSevenGenes()
    .then(logger("debug"))
    .catch(logger("error"));

  downloadBigsDbSchemes()
    .then(logger("debug"))
    .catch(logger("error"));

  downloadNcbiTaxDump()
    .then(logger("debug"))
    .catch(logger("error"));
}
