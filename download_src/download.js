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

const CACHE_DIR = "/opt/mlst/cache";

axios.defaults.headers.common["User-Agent"] =
  "mlst-downloader (https://gist.github.com/bewt85/16f2b7b9c3b331f751ce40273240a2eb)";

const PUBMLST_SEVEN_GENOMES_METADATA_URL =
  "https://pubmlst.org/data/dbases.xml";
const BIGSDB_SCHEME_METADATA_PATH = path.join(
  __dirname,
  "..",
  "bigsDb-schemes.json"
);
const RIDOM_SCHEME_METADATA_PATH = path.join(
  __dirname,
  "..",
  "ridom-schemes.json"
);
const ENTEROBASE_SCHEME_METADATA_PATH = path.join(
  __dirname,
  "..",
  "enterobase-schemes.json"
);
const TAXDUMP_HOST = "ftp.ncbi.nih.gov";
const TAXDUMP_REMOTE_PATH = "/pub/taxonomy/taxdump.tar.gz";

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
  return (
    path.join(CACHE_DIR, hostnameBitOfPath, ...middleBitOfPath) + searchSuffix
  );
}

async function createWriteStreamIfNotExists(outputPath) {
  const fd = await promisify(fs.open)(outputPath, "wx", 0o644);
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

  async downloadFile(url, downloadPath, options = {}) {
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
    options.responseType = "stream"; // eslint-disable-line no-param-reassign
    const response = await this.get(url, options);
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
    await whenOutputFileClosed;
    await promisify(fs.chmod)(downloadPath, 0o444);
    return downloadPath;
  }
}

const downloaders = {};
async function downloadFile(url, options = {}) {
  const urlObj = new URL(url);
  if (!_.has(downloaders, urlObj.hostname)) {
    downloaders[urlObj.hostname] = new SlowDownloader(1000);
  }
  const downloader = downloaders[urlObj.hostname];
  const downloadPath = urlToPath(url);
  return await downloader.downloadFile(url, downloadPath, options);
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

async function readJson(inputPath) {
  const jsonString = await promisify(fs.readFile)(inputPath);
  return JSON.parse(jsonString);
}

async function downloadPubMlstSevenGenes() {
  const metadataUrl = PUBMLST_SEVEN_GENOMES_METADATA_URL;
  const metadataPath = await downloadFile(metadataUrl);
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

async function downloadRidomSchemes() {
  const schemeMetadata = await readJson(RIDOM_SCHEME_METADATA_PATH);
  const alleleDownloads = _.map(
    schemeMetadata,
    async ({ url }) => await downloadFile(url)
  );
  return Promise.all(alleleDownloads);
}

async function downloadEnterobaseSchemes() {
  if (typeof process.env.ENTEROBASE_API_KEY === "undefined") {
    return Promise.reject("Please set ENTEROBASE_API_KEY environment variable");
  }
  const downloadOptions = {
    auth: { username: process.env.ENTEROBASE_API_KEY, password: "" }
  };
  const schemeMetadata = await readJson(ENTEROBASE_SCHEME_METADATA_PATH);
  const alleleUrls = [];
  const schemeUrls = [];
  const schemeDownloads = _.map(schemeMetadata, async ({ url }) => {
    let nextUrl = url;
    while (typeof nextUrl !== "undefined") {
      schemeUrls.push(nextUrl);
      const nextPath = await downloadFile(nextUrl, downloadOptions);
      const nextData = await readJson(nextPath);
      _.forEach(nextData.loci || [], ({ download_alleles_link }) =>
        alleleUrls.push(download_alleles_link)
      );
      nextUrl = _.get(nextData, "links.paging.next");
    }
  });
  await Promise.all(schemeDownloads);
  await Promise.all(
    _.map(alleleUrls, async (url, idx) => {
      await downloadFile(url, downloadOptions);
      logger("trace:downloadEntrobaseSchemes")(
        `Downloaded ${idx + 1} of ${alleleUrls.length} files`
      );
    })
  );
  return _.concat(schemeUrls, alleleUrls);
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

  let onStreamingStart;
  let onStreamError;
  const whenStreaming = new Promise((resolve, reject) => {
    onStreamingStart = resolve;
    onStreamError = reject;
  });

  const ftp = new Client();
  ftp.on("error", onStreamError);
  ftp.on("ready", () => {
    logger("debug:ftpDownload")(
      `Dowloading '${TAXDUMP_REMOTE_PATH}' from ${TAXDUMP_HOST}`
    );
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
      logger("debug:ftpDownload")(
        `Downloaded 'taxdump.tar.gz' to '${taxdumpPath}'`
      );
      resolve(taxdumpPath);
    });
  });
  taxdumpStream.pipe(outstream);
  return whenDownloadComplete;
}

module.exports = { urlToPath };

async function downloadAll() {
  return _.concat(
    await downloadPubMlstSevenGenes(),
    await downloadBigsDbSchemes(),
    await downloadRidomSchemes(),
    await downloadEnterobaseSchemes(),
    await downloadNcbiTaxDump()
  );
}

if (require.main === module) {
  downloadAll()
    .then(downloads => logger("debug")(`${downloads.length} downloads cached`))
    .catch(logger("error"));
}
