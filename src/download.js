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

class RateLimiter {
  constructor(minWait) {
    this.minWait = minWait; // ms
    this.whenNextTaskStart = Promise.resolve(null);
    this.queueLength = 0;
  }

  async queue(fn) {
    this.queueLength += 1;
    const whenDone = new DeferredPromise();
    const earliestNextRequest = this.whenNextTaskStart.then(() =>
      delay(this.minWait)
    );
    const whenWeStart = this.whenNextTaskStart;
    this.whenNextTaskStart = Promise.all([earliestNextRequest, whenDone]);
    await whenWeStart;
    try {
      whenDone.resolve(await fn());
    } catch (err) {
      whenDone.reject(err);
    }
    this.queueLength -= 1;
    return whenDone
  }
}

class SlowDownloader {
  constructor(minWait = 1000) {
    this.rateLimiter = new RateLimiter(minWait);
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

  curl(url, outPath, auth) {
    // This looks and is stupid but we have a corporate proxy and I lost the will to try
    // yet another library to reliably download things.  curl always seemed to work so that's
    // what we're using.  I'm sorry, I'm a little embarased, but life is short.
    const whenDownloaded = new DeferredPromise();

    let args;
    if (!auth) {
      args = [
        "--user-agent", USER_AGENT,
        "-s", "-S",
        "--max-time", "60",
        "--output", outPath,
        url
      ];
    } else {
      const { username="", password="" } = auth;
      args = [
        "--user", `${username}:${password}`,
        "--user-agent", USER_AGENT,
        "-s", "-S",
        "--max-time", "60",
        "--output", outPath,
        url
      ];
    }

    logger("trace:SlowDownloader")(`Downloading ${url}`);
    const shell = spawn("curl", args);

    let error = "";
    const whenError = new DeferredPromise();
    shell.stderr.on("data", chunk => {
      error += chunk;
    }).on("end", () => {
      whenError.resolve(error);
    })

    shell.on("error", err => {
      logger("error:curl")(err);
      whenDownloaded.reject(err);
    });
    shell.on("exit", (code, signal) => {
      if (code === 0) {
        logger("trace:curl")(
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

    const tmpPath = await this._tempPath();
    try {
      logger("trace:SlowDownloader")(`Queueing ${url}`);
      await this.rateLimiter.queue(() => this.curl(url, tmpPath, auth));
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
