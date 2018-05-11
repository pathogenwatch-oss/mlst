const axios = require("axios");
const Promise = require("bluebird");
const FtpClient = require("ftp");
const logger = require("debug");
const fs = require("fs");
const hasha = require("hasha");
const _ = require("lodash");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const tmp = require("tmp");
const { URL } = require("url");
const { promisify } = require("util");

const { DeferredPromise } = require("../src/utils");

const DOWNLOAD_RETRIES = 5;
const CACHE_DIR = "/opt/mlst/cache";
const TMP_CACHE_DIR = path.join(CACHE_DIR, "tmp");

axios.defaults.headers.common["User-Agent"] =
  "mlst-downloader (https://gist.github.com/bewt85/16f2b7b9c3b331f751ce40273240a2eb)";

const existsAsync = promisify(fs.exists);

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

async function ftpDownloadFile(url) {
  const urlParts = new URL(url);
  const { host, urlPath } = urlParts;
  const outPath = urlToPath(url);
  const dirname = path.dirname(outPath);
  await mkdirp(dirname, { mode: 0o755 });

  try {
    // Don't start a download if we already have a copy of the file
    await promisify(fs.access)(outPath, fs.constants.F_OK);
    logger("trace:SlowDownloader")(`${outPath} already exists, skipping`);
    return outPath;
  } catch (err) {
    // File isn't already downloaded
    (() => true)(); // Statement left intentionally blank to make linter happy
  }

  const { tmpPath, tmpStream } = await createTempFileStream();
  const whenStreaming = new DeferredPromise();

  const ftp = new FtpClient();
  ftp.on("error", err => whenStreaming.reject(err));
  ftp.on("ready", () => {
    logger("debug:ftpDownloadFile")(`Dowloading '${urlPath}' from ${host}`);
    ftp.get(urlPath, (err, stream) => {
      if (err) whenStreaming.reject(err);
      stream.once("close", () => ftp.end());
      whenStreaming.resolve(stream);
    });
  });
  ftp.connect({ host });
  const taxdumpStream = await whenStreaming;

  const whenTmpFileClosed = new Promise(resolve => {
    tmpStream.on("close", () => {
      logger("trace:ftpDownloadFile")(`Written ${urlParts} to ${tmpPath}`);
      resolve(tmpPath);
    });
  });
  taxdumpStream.pipe(tmpStream);
  await whenTmpFileClosed;

  await promisify(fs.rename)(tmpPath, outPath);
  await promisify(fs.chmod)(outPath, 0o444);

  return outPath;
}

async function getFromCache(url) {
  const expectedPath = urlToPath(url);
  const exists = await existsAsync(expectedPath);
  if (exists) return expectedPath;
  throw new Error(`${url} hasn't been downloaded`);
}

module.exports = { downloadFile, ftpDownloadFile, getFromCache };
