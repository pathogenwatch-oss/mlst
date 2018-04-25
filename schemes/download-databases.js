const axios = require("axios");
const Promise = require("bluebird");
const cheerio = require("cheerio");
const logger = require("debug");
const fs = require("fs");
const Client = require("ftp");
const hasha = require("hasha");
const _ = require("lodash");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const tmp = require("tmp");
const { URL } = require("url");
const { promisify } = require("util");
const { parseString: parseXml } = require("xml2js");

const { fail, DeferredPromise } = require("../src/utils");

const readFileAsync = promisify(fs.readFile);
const parseXmlAsync = promisify(parseXml);

process.on("unhandledRejection", reason => fail("unhandledRejection")(reason));

const DOWNLOAD_RETRIES = 5
const CACHE_DIR = "/opt/mlst/cache";
const TMP_CACHE_DIR = path.join(CACHE_DIR, "tmp");

axios.defaults.headers.common["User-Agent"] =
  "mlst-downloader (https://gist.github.com/bewt85/16f2b7b9c3b331f751ce40273240a2eb)";

const PUBMLST_SEVEN_GENOMES_METADATA_URL =
  "https://pubmlst.org/data/dbases.xml";
const PASTEUR_SCHEME_METADATA_PATH = path.join(
  __dirname,
  "pasteur-schemes.json"
);
const PUBMLST_SCHEME_METADATA_PATH = path.join(
  __dirname,
  "pubmlst-schemes.json"
);
const RIDOM_SCHEME_METADATA_PATH = path.join(__dirname, "ridom-schemes.json");
const ENTEROBASE_SCHEME_METADATA_PATH = path.join(
  __dirname,
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

function delay(wait) {
  return new Promise(resolve => {
    setTimeout(resolve, wait);
  });
}

async function createTempFileStream() {
  const whenTempFile = new Promise((resolve, reject) => {
    tmp.file(
      { mode: 0o644, prefix: "mlst-download-", dir: TMP_CACHE_DIR },
      (err, tmpPath, tmpFd) => {
        if (err) reject(err);
        resolve({ tmpPath, tmpFd });
      }
    );
  });
  const { tmpPath, tmpFd } = await whenTempFile;
  const tmpStream = fs.createWriteStream("", { fd: tmpFd });
  return { tmpPath, tmpFd, tmpStream };
}

class SlowDownloader {
  constructor(minWait = 1000) {
    this.minWait = minWait; // ms
    this.nextRequestAllowed = Promise.resolve(null);
    this.queueLength = 0;
  }

  async get(...options) {
    this.queueLength += 1;
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
    this.queueLength -= 1;
    onOurRequestComplete();
    return response;
  }

  async downloadToTempFile(url, options) {
    const { tmpPath, tmpStream } = await createTempFileStream();
    const response = await this.get(url, options);
    const whenTmpFileClosed = new Promise(resolve => {
      tmpStream.on("close", () => {
        logger("trace:SlowDownloader")(`Written ${url} to ${tmpPath}`);
        resolve(tmpPath);
      });
    });
    response.data.pipe(tmpStream);
    await whenTmpFileClosed;
    return tmpPath;
  }

  async downloadFile(url, options = {}) {
    const downloadPath = urlToPath(url);
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
      (() => true)(); // Statement left intentionally blank to make linter happy
    }
    options.responseType = "stream"; // eslint-disable-line no-param-reassign
    let tmpPath;
    try {
      tmpPath = await this.downloadToTempFile(url, options);
    } catch (err) {
      throw new Error(`Downloading ${url} to ${downloadPath}\n${err}`);
    }
    await promisify(fs.rename)(tmpPath, downloadPath);
    await promisify(fs.chmod)(downloadPath, 0o444);
    return downloadPath;
  }
}

const downloaders = {};
const downloadCache = {};

async function downloadFile(url, options = {}) {
  if (_.has(downloadCache, url)) {
    return downloadCache[url];
  }
  const response = new DeferredPromise();
  downloadCache[url] = response;

  const urlObj = new URL(url);
  const { hostname } = urlObj;
  if (!_.has(downloaders, hostname)) {
    downloaders[hostname] = new SlowDownloader(1000);
  }
  const downloader = downloaders[hostname];

  for (let i = 0; i < DOWNLOAD_RETRIES; i++) {
    try {
      const outPath = await downloader.downloadFile(url, options);
      logger("trace:downloadFile")(
        `${downloader.queueLength} files left in ${hostname} queue`
      );
      response.resolve(outPath);
      break;
    } catch (err) {
      logger("trace:downloadFile")(`Error: requeueing ${url}`);
      if (i === DOWNLOAD_RETRIES - 1) {
        response.reject(err);
      }
    }
  }

  return response;
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
  const metadata = await parseXmlAsync(metadataContent);
  const urls = extractUrlsForPubMlstSevenGenes(metadata);
  const downloads = _.map(urls, async url => await downloadFile(url));
  const downloadPaths = await Promise.all(downloads);
  return [metadataPath, ...downloadPaths];
}

async function downloadBigsDbSchemesRest(metadataPath) {
  const schemeMetadata = await readJson(metadataPath);
  const schemeUrls = _(schemeMetadata).map(({ url }) => url).uniq().value();
  const schemePaths = await Promise.map(
    schemeUrls,
    async url => await downloadFile(url)
  );
  const schemeDetails = await Promise.map(
    schemePaths,
    async downloadPath => await readJson(downloadPath)
  );
  const alleleUrls = _(schemeDetails)
    .flatMap(schemeData =>
      _.map(schemeData.loci, url => `${url}/alleles_fasta`)
    )
    .uniq()
    .value();
  const allelePaths = await Promise.map(
    alleleUrls,
    async url => await downloadFile(url)
  );
  return [...schemePaths, ...allelePaths];
}

async function parseBigsDbHtml(downloadUrl, downloadPath) {
  const content = await readFileAsync(downloadPath);
  const $ = cheerio.load(content.toString());
  const { origin: urlRoot } = new URL(downloadUrl);

  function parseRow(row) {
    const columns = $(row).find("td");
    if (columns.length < 2) {
      return null;
    }
    const urlPath = $(columns[1]).find("a").attr("href");
    if (!urlPath) return null;
    const locus = $(columns[0]).text();
    return { locus, url: `${urlRoot}${urlPath}` };
  }

  const rows = $("table.resultstable").find("tr");
  const loci = [];
  rows.each((i, row) => {
    const locus = parseRow(row);
    if (locus) {
      loci.push(locus);
    }
  });

  return loci;
}

async function downloadBigsDbSchemesHtml(metadataPath) {
  const schemeMetadata = await readJson(metadataPath);
  const downloaded = [];
  await Promise.map(schemeMetadata, async scheme => {
    const { taxid, url, lociCount } = scheme;
    const schemePath = await downloadFile(url);
    const schemeLoci = await parseBigsDbHtml(url, schemePath);
    if (schemeLoci.length !== lociCount) {
      throw new Error(
        `Expected ${lociCount} for ${taxid}, got ${schemeLoci.length}`
      );
    }
    downloaded.push(schemePath);
    const lociPaths = await Promise.map(schemeLoci, ({ url: lociUrl }) =>
      downloadFile(lociUrl)
    );
    downloaded.push(lociPaths);
  });
  return _(downloaded).flatten().uniq().value();
}

async function downloadRidomSchemes() {
  const schemeMetadata = await readJson(RIDOM_SCHEME_METADATA_PATH);
  const alleleDownloads = Promise.map(
    schemeMetadata,
    async ({ url }) => await downloadFile(url)
  );
  return Promise.all(alleleDownloads); // Scheme might be shared between species
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
  await Promise.map(
    schemeMetadata,
    async ({ url }) => {
      let nextUrl = url;
      while (typeof nextUrl !== "undefined") {
        if (schemeUrls.indexOf(nextUrl) === -1) schemeUrls.push(nextUrl); // Scheme might be shared between species
        const nextPath = await downloadFile(nextUrl, downloadOptions);
        const nextData = await readJson(nextPath);
        _.forEach(nextData.loci || [], ({ download_alleles_link }) => {
          if (alleleUrls.indexOf(download_alleles_link) === -1)
            alleleUrls.push(download_alleles_link); // Might be a duplicate from another scheme
        });
        nextUrl = _.get(nextData, "links.paging.next");
      }
    },
    { concurrency: 1 } // Scheme might be shared between species
  );
  await Promise.all(
    _.map(alleleUrls, async url => await downloadFile(url, downloadOptions))
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
    (() => true)(); // Statement left intentionally blank to make linter happy
  }

  const { tmpPath, tmpStream } = await createTempFileStream();

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

  const whenTmpFileClosed = new Promise(resolve => {
    tmpStream.on("close", () => {
      logger("trace:ftpDownload")(`Written ${taxdumpUrl} to ${tmpPath}`);
      resolve(tmpPath);
    });
  });
  taxdumpStream.pipe(tmpStream);
  await whenTmpFileClosed;

  await promisify(fs.rename)(tmpPath, taxdumpPath);
  await promisify(fs.chmod)(taxdumpPath, 0o444);

  return taxdumpPath;
}

module.exports = { urlToPath, parseBigsDbHtml };

async function downloadAll() {
  await mkdirp(TMP_CACHE_DIR, { mode: 0o755 });
  const downloads = await Promise.all([
    downloadPubMlstSevenGenes(),
    downloadBigsDbSchemesRest(PUBMLST_SCHEME_METADATA_PATH),
    downloadBigsDbSchemesHtml(PASTEUR_SCHEME_METADATA_PATH),
    downloadRidomSchemes(),
    downloadEnterobaseSchemes(),
    downloadNcbiTaxDump()
  ]);
  return _.concat(...downloads);
}

if (require.main === module) {
  downloadAll()
    .then(downloads => logger("debug")(`${downloads.length} downloads cached`))
    .catch(fail("error"));
}
