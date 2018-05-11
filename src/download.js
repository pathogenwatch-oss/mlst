const axios = require("axios");
const Promise = require("bluebird");
const { spawn } = require("child_process");
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

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    logger("trace:downloadFile")(`Attempt ${attempt} to download ${url}`);
    try {
      const outPath = await downloader.downloadFile(url, options);
      logger("trace:downloadFile")(
        `${downloader.queueLength} files left in ${hostname} queue`
      );
      response.resolve(outPath);
      break;
    } catch (err) {
      logger("trace:downloadFile")(`Error: requeueing ${url} because\n${err}`);
      if (attempt === DOWNLOAD_RETRIES) {
        response.reject(err);
      }
    }
  }

  return response;
}

async function ftpDownloadFile(url) {
  const outPath = urlToPath(url);
  const dirname = path.dirname(outPath);
  await mkdirp(dirname, { mode: 0o755 });

  try {
    // Don't start a download if we already have a copy of the file
    await promisify(fs.access)(outPath, fs.constants.F_OK);
    logger("trace:ftpDownloadFile")(`${outPath} already exists, skipping`);
    return outPath;
  } catch (err) {
    // File isn't already downloaded
    (() => true)(); // Statement left intentionally blank to make linter happy
  }

  const whenTempPath = new Promise((resolve, reject) => {
    tmp.tmpName(
      { mode: 0o644, prefix: "mlst-download-", dir: TMP_CACHE_DIR },
      (err, tmpPath) => {
        if (err) reject(err);
        resolve(tmpPath);
      }
    );
  })

  const tmpPath = await whenTempPath;
  const command = `wget --quiet --timeout=60 --output-document=${tmpPath} ${url}`;
  logger("trace:ftpDownloadFile")(`Running ${command}`);
  const shell = spawn(command, { shell: true });
  const whenDownloaded = new DeferredPromise();
  shell.on("error", err => {
    logger("error:ftpDownloadFile")(err);
    whenDownloaded.reject(err);
  });
  shell.on("exit", async (code, signal) => {
    if (code === 0) {
      logger("trace:ftpDownloadFile")(
        `Downloaded ${url} to ${tmpPath}`
      );
      whenDownloaded.resolve(tmpPath);
    } else {
      whenDownloaded.reject(`Got ${code}:${signal} while downloading ${url}`);
    }
  });

  await whenDownloaded;
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
