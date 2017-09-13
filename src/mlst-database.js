const _ = require("lodash");
const axios = require("axios");
const AsyncLock = require("async-lock");
const fasta = require("bionode-fasta");
const fs = require("fs");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const hasha = require("hasha");
const logger = require("debug");
const readline = require("readline");
const tmp = require("tmp");

const { Transform } = require("stream");
const { parseString } = require("xml2js");

const { DeferredPromise, pmap, splitResolveReject, parseAlleleName } = require("./utils");

const MLST_DIR = "/opt/mlst/databases";
const ALLELE_LOOKUP_PREFIX_LENGTH = 20;

function delay(wait) {
  return new Promise(resolve => {
    setTimeout(resolve, wait);
  });
}

class SlowDownloader {
  constructor(minWait = 1000) {
    this.minWait = minWait; // ms
    this.latest = Promise.resolve(null);
  }

  get(...options) {
    logger("trace:SlowDownloader")(`Queueing ${options[0]}`);
    const response = this.latest.then(() => axios.get(...options));
    const wait = this.latest.then(() => delay(this.minWait));
    response.then(() => logger("trace:SlowDownloader")(`Downloaded ${options[0]}`));
    this.latest = Promise.all([response, wait]);
    return response;
  }
}

class FastaString extends Transform {
  constructor(options = {}) {
    super(_.assign(options, { objectMode: true }));
  }

  _transform(chunk, encoding, callback) {
    const output = `>${chunk.id}\n${chunk.seq}\n`;
    this.push(output);
    callback();
  }
}

class Metadata {
  _parseAlleleFile(alleleFilePath) {
    logger("trace:metadata:analyse")(`Analysing ${alleleFilePath}`);
    const seqStream = fasta.obj(alleleFilePath);
    seqStream.pause()
    const alleleLookup = {};

    const output = new DeferredPromise();

    seqStream.on("data", seq => {
      const allele = seq.id;
      logger("trace:alleleDetails")(
        `Analysing ${allele} from ${alleleFilePath}`
      );
      const sequence = seq.seq.toLowerCase();
      const length = seq.seq.length;
      const hash = hasha(sequence, { algorithm: "sha1" });
      const prefix = sequence.slice(0, ALLELE_LOOKUP_PREFIX_LENGTH);
      (alleleLookup[prefix] = alleleLookup[prefix] || []).push([allele, length, hash]);

      const reverseCompliment = _(sequence.split(""))
        .reverse()
        .map(b => ({ t: "a", a: "t", c: "g", g: "c" }[b] || b))
        .value()
        .join("");
      const rcHash = hasha(reverseCompliment, { algorithm: "sha1" });
      const rcPrefix = reverseCompliment.slice(0, ALLELE_LOOKUP_PREFIX_LENGTH);
      (alleleLookup[rcPrefix] = alleleLookup[rcPrefix] || []).push([allele, length, rcHash]);
    });

    seqStream.on("end", () => {
      logger("debug:alleleDetails")(
        `Finished reading alleles from ${alleleFilePath}`
      );
      output.resolve(alleleLookup);
    });
    seqStream.resume()

    return output;
  }

  _parseAlleleDetails(allelePaths) {
    const alleleLookups = _.map(allelePaths, this._parseAlleleFile);
    return Promise.all(alleleLookups).then(results => {
      const alleleLookup = {};
      const lengths = {};

      // Results is a list of results from which look like:
      // { prefixSequence: [[name, length, hash], [anotherName, length, hash]],
      //   anotherPrefixSequence: [[name, length, hash]]}
      // We want to join the results from each allele file so that given a bit
      // of sequence, we can look up all of the alleles which it might match.
      // The following line does this:
      //
      // > alleleLookup = {}
      // {}
      // > results = [{1: [2, 3]}, {4: [5]}, {1: [6,7], 8:[9]}]
      // [ { '1': [ 2, 3 ] },
      //   { '4': [ 5 ] },
      //   { '1': [ 6, 7 ], '8': [ 9 ] } ]
      // > ld.assignWith(alleleLookup, ...results, (a, b) => (a || []).concat(b))
      // { '1': [ 2, 3, 6, 7 ], '4': [ 5 ], '8': [ 9 ] }

      _.assignWith(alleleLookup, ...results, (a, b) => (a || []).concat(b));

      // We then want to sort the alleleLookup so that longer alleles are
      // listed first

      _.forEach(_.keys(alleleLookup), allelePrefix => {
        const alleleList = alleleLookup[allelePrefix];
        _.forEach(alleleList, ([allele, length]) => (lengths[allele] = length));
        alleleLookup[allelePrefix] = _.sortBy(alleleList, allele => -allele[1]);
      });

      return { alleleLookup, lengths };
    });
  }

  _getMostCommonGeneLengths(lengths) {
    const geneLengthCounts = {};
    _.forEach(_.toPairs(lengths), ([allele, length]) => {
      const { gene } = parseAlleleName(allele);
      geneLengthCounts[gene] = geneLengthCounts[gene] || {};
      geneLengthCounts[gene][length] =
        (geneLengthCounts[gene][length] || 0) + 1;
    });
    const mostCommonGeneLengths = {};
    _.forEach(_.keys(geneLengthCounts), gene => {
      const [mostCommonLength] = _.maxBy(
        _.toPairs(geneLengthCounts[gene]),
        ([, count]) => count
      );
      mostCommonGeneLengths[gene] = Number(mostCommonLength);
    });
    return mostCommonGeneLengths;
  }

  _buildProfileRowParser(genes, header) {
    return row => {
      const rowObj = _(header).zip(row).fromPairs().value();
      const alleles = _.map(genes, gene => rowObj[gene]);
      const ST = rowObj.ST;
      return { ST, alleles };
    };
  }

  _getProfiles(options = {}) {
    const { profilesPath, genes } = options;
    logger("debug:metadata:profile")(
      `Loading profile data from ${profilesPath}`
    );
    const output = new DeferredPromise();
    let rowParser = null;

    const profileData = {};
    const profileFileStream = readline.createInterface({
      input: fs.createReadStream(profilesPath)
    });

    profileFileStream.on("line", line => {
      const row = line.split("\t");
      if (rowParser === null) {
        // This is the header row
        rowParser = this._buildProfileRowParser(genes, row);
      } else {
        const { ST, alleles } = rowParser(row);
        const allelesKey = alleles.join("_");
        profileData[allelesKey] = ST;
      }
    });

    profileFileStream.on("close", () => {
      logger("debug:metadata:profile")(
        `Found ${_.keys(profileData).length} profiles in ${profilesPath}`
      );
      output.resolve(profileData);
    });

    return output;
  }

  // eslint-disable-next-line max-params
  buildMetadata(
    species,
    scheme,
    genes,
    allelePaths,
    profilesPath,
    retrieved,
    url
  ) {
    logger("debug:metadata:buildMetadata")(`Building metadata for ${species}`);
    const outputs = {
      species,
      allelePaths,
      genes,
      lengths: new DeferredPromise(),
      alleleLookups: new DeferredPromise(),
      alleleLookupPrefixLength: ALLELE_LOOKUP_PREFIX_LENGTH,
      profiles: this._getProfiles({ profilesPath, genes }),
      scheme,
      profilesPath,
      commonGeneLengths: new DeferredPromise(),
      retrieved,
      url
    };
    this._parseAlleleDetails(allelePaths)
      .then(({ alleleLookups, lengths }) => {
        logger("trace:metadata:buildMetadata")(
          `Built hashes and lengths for ${species}`
        );
        outputs.alleleLookups.resolve(alleleLookups);
        outputs.lengths.resolve(lengths);
      })
      .catch("error:metadata:buildMetadata");

    const commonGeneLengths = outputs.commonGeneLengths;
    outputs.lengths
      .then(this._getMostCommonGeneLengths)
      .then(commonGeneLengths.resolve.bind(commonGeneLengths))
      .then(() =>
        logger("trace:metadata:buildMetadata")(
          `Found commonest gene lengths for ${species}`
        )
      )
      .catch("error:metadata:buildMetadata");

    // Some of the values of output are promises.  Instead,
    // we would like to return a Promise to an object which
    // doesn't have any Promises in it.
    // i.e. turn {a: 1, b: Promise(2), c: Promise(3)}
    //      into Promise({a: 1, b: 2, c: 3})
    return Promise.all(_.values(outputs)).then(values => {
      logger("trace:metadata:buildMetadata")(
        `Resolved promises for metadata for ${species}`
      );
      return _.fromPairs(_.zip(_.keys(outputs), values));
    });
  }

  writeMetadata(outPath, ...options) {
    return this.buildMetadata(...options).then(data => {
      const { species } = data;
      logger("debug:metadata:write")(
        `Writing metadata for ${species} to ${outPath}`
      );
      const jsonData = JSON.stringify(data);
      return new Promise((resolve, reject) => {
        fs.writeFile(outPath, jsonData, { mode: 0o644 }, err => {
          if (err) {
            logger("error")(err);
            reject(err);
          }
          logger("debug:metadata:write")(
            `Wrote metadata for ${species} to ${outPath}`
          );
          resolve(data);
        });
      });
    });
  }
}

class PubMlstSevenGenomeSchemes extends Metadata {
  constructor(dataDir = MLST_DIR) {
    super();
    this.PUBMLST_URL = "https://pubmlst.org/data/dbases.xml";
    this.dataDir = dataDir;
    this.metadataPath = path.join(dataDir, "metadata.json");
    this.lock = new AsyncLock();
    this.downloader = new SlowDownloader(1000);
  }

  read(taxid) {
    const rootMetadata = require(this.metadataPath);
    try {
      const speciesMetadataPath = rootMetadata[String(taxid)].metadataPath;
      return require(speciesMetadataPath);
    } catch (err) {
      return undefined;
    }
  }

  update(speciesTaxIdsMap = {}) {
    const allSpeciesMlstMetadata = {};
    return this._getPubMlstMetadata(this.PUBMLST_URL).then(pubMlstMetadata => {
      const latestMetadata = this._latestMetadata(pubMlstMetadata);
      const updatedMetadata = _.map(latestMetadata, speciesMetadata =>
        this._updateSpecies(speciesMetadata)
      );

      const writtenMetadata = pmap(updatedMetadata, data =>
        this.lock.acquire(this.metadataPath, () => {
          const { species } = data;
          let taxids;
          if (species.slice(-5) === " spp.") {
            const genus = species.slice(0,-5);
            taxids = speciesTaxIdsMap[genus];
          } else {
            taxids = speciesTaxIdsMap[species];
          }
          if (taxids && taxids.length > 0) {
            _.forEach(taxids, taxid => {
              data.taxid = taxid; // eslint-disable-line no-param-reassign
              allSpeciesMlstMetadata[taxid] = data;
            });
            return this._writeRootMetadata(
              allSpeciesMlstMetadata,
              this.metadataPath
            );
          }
          return Promise.reject(`Could not find taxid for ${species}`);
        })
      );

      const resolvedRejected = splitResolveReject(writtenMetadata);
      const output = resolvedRejected.then(({ resolved, rejected }) => {
        logger("debug")(
          `Finished writing metadata for ${resolved.length} species`
        );
        logger("error")(`There were ${rejected.length} errors`);
        _.forEach(rejected, p => p.catch(logger("error")));
        return allSpeciesMlstMetadata;
      });

      return output;
    });
  }

  _latestMetadata(metadata) {
    // Some species have multiple MLST schemes, find the latest one
    const maxVersion = {};
    const latestVersionOfSpeciesData = {};

    _.forEach(metadata, speciesData => {
      const nameParts = speciesData.species.split("#");
      const species = nameParts[0];
      const version = Number(nameParts[1] || 0);
      if ((maxVersion[species] || -1) < version) {
        maxVersion[species] = version;
        latestVersionOfSpeciesData[species] = speciesData;
      }
    });

    _(latestVersionOfSpeciesData)
      .toPairs()
      .forEach(([species, speciesData]) => {
        if (species !== speciesData.species) {
          logger("debug:update:latest")(
            `Using ${speciesData.species} for ${species}`
          );
          speciesData.species = species; // eslint-disable-line no-param-reassign
        }
      });

    return _.values(latestVersionOfSpeciesData);
  }

  _writeRootMetadata(metadata, outPath) {
    const jsonData = JSON.stringify(metadata);
    const output = new DeferredPromise();
    fs.writeFile(outPath, jsonData, { mode: 0o644 }, err => {
      if (err) output.reject(err);
      logger("debug:metadataWrite")(`Wrote metadata to ${outPath}`);
      output.resolve(outPath);
    });
    return output;
  }

  _updateSpecies(speciesData) {
    const { species, scheme, genes, retrieved, url } = speciesData;
    logger("debug:updateSpecies")(`Updating details for ${species}`);
    const downloadedFiles = this._downloadSpecies(speciesData, this.dataDir);
    const sortedFiles = downloadedFiles.then(({ allelePaths, profilesPath }) =>
      Promise.all(this._sortAlleleSequences(allelePaths)).then(() => ({
        species,
        allelePaths,
        profilesPath
      }))
    );
    const metadata = sortedFiles.then(({ allelePaths, profilesPath }) =>
      this._updateSpeciesMetadata(
        this.dataDir,
        species,
        scheme,
        genes,
        allelePaths,
        profilesPath,
        retrieved,
        url
      )
    );
    return Promise.all([sortedFiles, metadata]).then(([, metadataPath]) => ({
      species,
      scheme,
      genes,
      metadataPath,
      retrieved
    }));
  }

  // eslint-disable-next-line max-params
  _updateSpeciesMetadata(
    dataDir,
    species,
    scheme,
    genes,
    allelePaths,
    profilesPath,
    retrieved,
    url
  ) {
    const speciesDir = this._speciesDir(species, dataDir);
    const outpath = path.join(speciesDir, "metadata.json");
    return this.writeMetadata(
      outpath,
      species,
      scheme,
      genes,
      allelePaths,
      profilesPath,
      retrieved,
      url
    ).then(() => outpath);
  }

  _speciesDir(species, dataDir) {
    const speciesDir = species
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/_+$/, "");
    const outDir = path.join(dataDir, speciesDir);
    return outDir;
  }

  _downloadFile(url, downloadPath) {
    logger("trace:pubmlst:download")(
      `In queue to download ${url} to ${downloadPath}`
    );
    return this.downloader.get(url, { responseType: "stream" })
      .then(response => {
        const outstream = fs.createWriteStream(downloadPath, { mode: 0o644 });
        response.data.pipe(outstream);
        return new Promise(resolve => {
          outstream.on("close", () => {
            logger("trace:pubmlst:downloaded")(
              `Downloaded ${url} to ${downloadPath})`
            );
            resolve(downloadPath);
          });
        });
      })
  }

  _downloadSpecies(speciesMetadata, dataDir) {
    const { species, scheme } = speciesMetadata;
    const speciesDir = this._speciesDir(species, dataDir);
    const alleleDir = path.join(speciesDir, "alleles");
    const profileDir = path.join(speciesDir, "profiles");
    const { loci } = speciesMetadata.database;

    const whenProfilesDownloaded = mkdirp(profileDir, {
      mode: 0o755
    }).then(() => {
      const { url } = speciesMetadata.database.profiles;
      const filename = `${scheme}.txt`;
      const downloadPath = path.join(profileDir, filename);
      return this._downloadFile(url, downloadPath);
    });
    whenProfilesDownloaded.then(filePath =>
      logger("debug:profilesPath")(`${scheme} => ${filePath}`)
    );

    const whenAllelesDownloaded = whenProfilesDownloaded
      .then(() => mkdirp(alleleDir, { mode: 0o755 }))
      .then(() =>
        Promise.all(
          _.map(loci, ({ locus, url }) => {
            const downloadPath = `${path.join(alleleDir, locus)}.tfa`;
            return this._downloadFile(url, downloadPath);
          })
        )
      );
    whenAllelesDownloaded.then(filePath =>
      logger("debug:allelePaths")(`${scheme} => ${filePath}`)
    );

    return Promise.all([
      whenAllelesDownloaded,
      whenProfilesDownloaded
    ]).then(([allelePaths, profilesPath]) => ({
      species,
      allelePaths,
      profilesPath
    }));
  }

  _getPubMlstMetadata(url) {
    return this.downloader.get(url)
      .then(
        response =>
          new Promise((resolve, reject) => {
            parseString(response.data, (err, result) => {
              if (err) reject(err);
              resolve(result);
            });
          })
      )
      .then(data => data.data.species)
      .then(species => _.map(species, this._parseDbConfig));
  }

  _parseDbConfig(data) {
    const species = data._.trim();
    const database = data.mlst[0].database[0];
    const url = database.url[0];
    const retrieved = database.retrieved[0];
    const profiles = database.profiles[0];
    const profilesCount = Number(profiles.count[0]);
    const profilesUrl = profiles.url[0];

    function parseLocus(locusData) {
      const locus = locusData._.trim();
      const locusUrl = locusData.url[0];
      return { locus, url: locusUrl };
    }

    const loci = _.map(database.loci[0].locus, parseLocus);
    const scheme = /([^\/]+)\.txt$/.exec(profilesUrl)[1];
    const genes = _.map(loci, locus => locus.locus);

    return {
      species,
      scheme,
      genes,
      retrieved,
      url,
      database: {
        profiles: {
          count: profilesCount,
          url: profilesUrl
        },
        loci
      }
    };
  }

  _sortAlleleSequences(allelePaths) {
    logger("trace:sortAlleleSequences:sorting")(allelePaths);
    function sortAlleleFile(allelePath) {
      return this._sortFastaBySequenceLength(allelePath).then(() => {
        logger("trace:sortAlleleSequences:sorted")(allelePath);
        return allelePath;
      });
    }
    const sorted = _.map(allelePaths, sortAlleleFile.bind(this));
    const updatedFastas = Promise.all(sorted);
    updatedFastas.then(paths => {
      logger("debug:sortAlleleSequences:sorted")(
        `Sorted ${paths.length} allele files`
      );
    });
    return sorted;
  }

  _sortFastaBySequenceLength(fastaPath) {
    const sequences = [];
    const seqStream = fasta.obj(fastaPath);

    const output = new DeferredPromise();
    const onDone = () => {
      output.resolve.bind(output)(fastaPath);
    };

    const sortSequences = () => {
      // Sorts the sequences so that you get a good mix of lengths
      // For example, if sequences == [{length: 5}, {length: 5}, {length: 5}, {length: 3}, {length: 3}, {length: 1}]
      // this returns: [{length: 5}, {length: 3}, {length: 1}, {length: 5}, {length: 3}, {length: 5}]
      const groupedByLength = _.reduce(
        sequences,
        (result, seq) => {
          (result[seq.length] = result[seq.length] || []).push(seq); // eslint-disable-line no-param-reassign
          return result;
        },
        {}
      );
      const lengths = _.keys(groupedByLength).sort();
      const sortedSequences = _(groupedByLength) // {455: [seq, ...], 460: [seq, ...], ...}
        .toPairs() // [[455, [seq, ...]], [460, [seq, ...]], ...]
        .sortBy(([length]) => -length) // [[477, [seq, ...]], [475, [seq, ...]], ...]
        .map(([, seqs]) => seqs) // [[seq1, seq2, ...], [seq11, seq12, ...], ...]
        .thru(seqs => _.zip(...seqs)) // [[seq1, seq11, ...], [seq2, undefined, ...], ...]
        .flatten() // [seq1, seq11, ..., seq2, undefined, ...]
        .filter(el => typeof el !== "undefined") // [seq1, seq11, ..., seq2, ...]
        .value();
      return { lengths, sortedSequences };
    };

    seqStream.on("data", seq => {
      seq.length = seq.seq.length; // eslint-disable-line no-param-reassign
      // There's a Gono allele without any sequence data :( - ignore it
      if (seq.length > 0) sequences.push(seq);
    });

    seqStream.on("end", () => {
      tmp.file((err, tempFastaPath) => {
        // eslint-disable-line max-params
        if (err) output.reject(err);
        const { sortedSequences } = sortSequences();
        const tempOutputfile = fs.createWriteStream(tempFastaPath, { mode: 0o644 });
        const fastaStream = new FastaString();
        fastaStream.pipe(tempOutputfile);
        _.forEach(sortedSequences, s => {
          fastaStream.write(s);
        });

        fastaStream.end();
        tempOutputfile.on("close", () => {
          logger("trace:sortFastaBySequenceLength:rename")([
            tempFastaPath,
            fastaPath
          ]);
          fs.rename(tempFastaPath, fastaPath, onDone);
        });
      });
    });

    return output;
  }
}

class BigsDbSchemes extends PubMlstSevenGenomeSchemes {
  constructor(dataDir = MLST_DIR) {
    super(dataDir);
    this.schemeDetailsPath = path.join(__dirname, "..", "cgMLST-schemes.json");
    this.metadataPath = path.join(dataDir, "metadataCore.json");
    this.downloader = new SlowDownloader(1000);
  }

  update() {
    let schemeDetails;
    try {
      schemeDetails = require(this.schemeDetailsPath);
    } catch (err) {
      logger('debug')(`Couldn't load details of Core Genome MLST schemes from ${this.schemeDetailsPath}`);
      return Promise.resolve({});
    }

    const allSpeciesMlstMetadata = this._getExistingMetadata();
    const existingUrlMap = _(allSpeciesMlstMetadata)
      .toPairs()
      .map(([taxid, { url }]) => [url, Number(taxid)])
      .uniqBy(([url]) => url)
      .fromPairs()
      .value();

    let previousSchemeUpdated = Promise.resolve(null);
    _.forEach(schemeDetails, ({ taxid, url }) => {
      const schemeName = `cgMLST_${taxid}`;
      previousSchemeUpdated = previousSchemeUpdated.then(() => {
        const identicalSchemeTaxid = existingUrlMap[url];
        if (identicalSchemeTaxid) {
          return this._linkToExistingMetadata(
            schemeName,
            taxid,
            identicalSchemeTaxid
          );
        }
        return this._updateScheme(schemeName, taxid, url).then(response => {
          existingUrlMap[url] = taxid;
          return response;
        });
      });
    });
    return previousSchemeUpdated.then(() => this._getExistingMetadata());
  }

  _getExistingMetadata() {
    try {
      return require(this.metadataPath);
    } catch (err) {
      logger('debug')(`Couldn't load metdata from ${this.metadataPath}:\n${err}`)
      return {};
    }
  }

  _linkToExistingMetadata(name, taxid, identicalSchemeTaxid) {
    const allSpeciesMlstMetadata = this._getExistingMetadata();
    const schemeData = allSpeciesMlstMetadata[String(identicalSchemeTaxid)];
    const existingMetadataPath = schemeData.metadataPath;
    const speciesMetadata = require(existingMetadataPath);
    speciesMetadata.species = name;
    speciesMetadata.scheme = name;
    const speciesDir = this._speciesDir(name, this.dataDir);
    const speciesDataPath = path.join(speciesDir, "metadata.json");

    const whenSpeciesDir = mkdirp(speciesDir, { mode: 0o755 });
    const whenWrittenSpeciesData = whenSpeciesDir.then(
      () =>
        new Promise((resolve, reject) => {
          const jsonData = JSON.stringify(speciesMetadata);
          fs.writeFile(speciesDataPath, jsonData, { mode: 0o644 }, err => {
            if (err) reject(err);
            resolve();
          });
        })
    );

    const whenWrittenMetadata = whenWrittenSpeciesData
      .then(() => {
        const newSchemeData = _.cloneDeep(schemeData);
        newSchemeData.name = name; // eslint-disable-line no-param-reassign
        newSchemeData.metadataPath = speciesDataPath; // eslint-disable-line no-param-reassign
        allSpeciesMlstMetadata[taxid] = newSchemeData;
        return this._writeRootMetadata(
          allSpeciesMlstMetadata,
          this.metadataPath
        );
      })
    .then(allSpeciesMlstMetadata);

    return whenWrittenMetadata
  }

  _updateScheme(name, taxid, schemeUrl) {
    const whenSchemeDetails = this.downloader.get(schemeUrl)
      .then(r => r.data)
      .then(data => {
        data.url = schemeUrl; // eslint-disable-line no-param-reassign
        return data;
      });
    const whenDownloadedAlleles = whenSchemeDetails.then(schemeData =>
      this._downloadScheme(name, schemeData, this.dataDir)
    );
    const whenGenes = whenSchemeDetails.then(schemeData =>
      _.map(schemeData.loci, url => url.split("/").pop())
    );
    const whenSortedAlleles = whenDownloadedAlleles.then(allelePaths =>
      Promise.all(this._sortAlleleSequences(allelePaths)).then(allelePaths)
    );

    const speciesDir = this._speciesDir(name, this.dataDir);
    const speciesDataPath = path.join(speciesDir, "metadata.json");
    const profilesPath = null;
    const retrieved = new Date();

    const whenWrittenSpeciesData = Promise.all([
      whenGenes,
      whenSortedAlleles
    ]).then(([genes, allelePaths]) =>
      this.writeMetadata(
        speciesDataPath,
        name,
        name,
        genes,
        allelePaths,
        profilesPath,
        retrieved,
        schemeUrl
      )
    );

    const whenWrittenMetadata = Promise.all([
      whenSchemeDetails,
      whenWrittenSpeciesData
    ]).then(([schemeData]) => {
      const allSpeciesMlstMetadata = this._getExistingMetadata();
      schemeData.name = name; // eslint-disable-line no-param-reassign
      schemeData.metadataPath = speciesDataPath; // eslint-disable-line no-param-reassign
      allSpeciesMlstMetadata[taxid] = schemeData;
      return this._writeRootMetadata(
        allSpeciesMlstMetadata,
        this.metadataPath
      );
    })
    .then(whenSchemeDetails);

    return whenWrittenMetadata
  }

  _speciesDir(name, dataDir) {
    const speciesDir = name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+$/, "");
    const outDir = path.join(dataDir, speciesDir);
    return outDir;
  }

  _downloadScheme(name, schemeData, dataDir) {
    const speciesDir = this._speciesDir(name, dataDir);
    const alleleDir = path.join(speciesDir, "alleles");
    const loci = _.map(schemeData.loci, url => {
      const locus = url.split("/").pop();
      return { locus, url: `${url}/alleles_fasta` };
    });
    const whenAllelesDownloaded = mkdirp(alleleDir, { mode: 0o755 }).then(() =>
      Promise.all(
        _.map(loci, ({ locus, url }) => {
          const downloadPath = `${path.join(alleleDir, locus)}.tfa`;
          return this._downloadFile(url, downloadPath);
        })
      )
    );
    whenAllelesDownloaded.then(filePath =>
      logger("debug:allelePaths")(`${name} => ${filePath}`)
    );
    return whenAllelesDownloaded;
  }

  _getProfiles() {
    return Promise.resolve({});
  }
}

module.exports = { parseAlleleName, PubMlstSevenGenomeSchemes, BigsDbSchemes, FastaString };
