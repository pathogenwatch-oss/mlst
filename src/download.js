const Promise = require("bluebird");
const { spawn } = require("child_process");
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

const USER_AGENT = "mlst-downloader (https://gist.github.com/bewt85/16f2b7b9c3b331f751ce40273240a2eb)";

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

class SlowDownloader {
  constructor(minWait = 1000) {
    this.minWait = minWait; // ms
    this.nextRequestAllowed = Promise.resolve(null);
    this.queueLength = 0;
  }

  async _tempPath() {
    return new Promise((resolve, reject) => {
      tmp.tmpName(
        { mode: 0o644, prefix: "mlst-download-", dir: TMP_CACHE_DIR },
        (err, tmpPath) => {
          if (err) reject(err);
          resolve(tmpPath);
        }
      );
    })
  }

  async wget(url, outPath, auth) {
    // This looks and is stupid but we have a corporate proxy and I lost the will to try
    // yet another library to reliably download things.  wget always seemed to work so that's
    // what we're using.  I'm sorry, I'm a little embarased, but life is short.
    const whenDownloaded = new DeferredPromise();

    let command;
    if (!auth) {
      command = `wget --user-agent="${USER_AGENT}" --no-verbose --timeout=60 --output-document=${outPath} ${url}`;
    } else {
      const { username="", password="" } = auth;
      command = `wget --http-user=${username} --http-passwd=${password} --no-verbose `
                `--user-agent="${USER_AGENT}"  --timeout=60 --output-document=${outPath} ${url}`;
    }

    logger("trace:command")(command);
    const shell = spawn(command, { shell: true });

    let error = "";
    const whenError = new DeferredPromise();
    shell.stderr.on("data", chunk => {
      error += chunk;
    }).on("end", () => {
      whenError.resolve(error);
    })

    shell.on("error", err => {
      logger("error:wget")(err);
      whenDownloaded.reject(err);
    });
    shell.on("exit", async (code, signal) => {
      if (code === 0) {
        logger("trace:wget")(
          `Downloaded ${url} to ${outPath}`
        );
        whenDownloaded.resolve(outPath);
      } else {
        whenError.then(err => {
          const message = `Got ${code}:${signal} while downloading ${url}:\n${err}`;
          whenDownloaded.reject(message);
        })
      }
    });

    return whenDownloaded;
  }

  async downloadToTempFile(url, auth) {
    const tmpPath = await this._tempPath();
    this.queueLength += 1;
    const whenOurRequestComplete = new DeferredPromise();
    logger("trace:SlowDownloader")(`Queueing ${url}`);
    const earliestNextRequest = this.nextRequestAllowed.then(() =>
      delay(this.minWait)
    );
    const whenWeCanMakeRequest = this.nextRequestAllowed;
    this.nextRequestAllowed = Promise.all([
      earliestNextRequest,
      whenOurRequestComplete
    ]);
    await whenWeCanMakeRequest;
    await this.wget(url, tmpPath, auth)
    whenOurRequestComplete.resolve();
    this.queueLength -= 1;
    return tmpPath;
  }

  async downloadFile(url, auth) {
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
    let tmpPath;
    try {
      tmpPath = await this.downloadToTempFile(url, auth);
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

async function downloadFile(url, auth=null) {
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
      const outPath = await downloader.downloadFile(url, auth);
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

async function getFromCache(url) {
  const expectedPath = urlToPath(url);
  const exists = await existsAsync(expectedPath);
  if (exists) return expectedPath;
  throw new Error(`${url} hasn't been downloaded`);
}

module.exports = { downloadFile, getFromCache };
