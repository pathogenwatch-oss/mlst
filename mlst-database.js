'use strict';

const _ = require('lodash');
const axios = require('axios');
const AsyncLock = require('async-lock');
const fasta = require('bionode-fasta');
const fs = require('fs');
const mkdirp = require('mkdirp-promise')
const path = require('path');
const hasha = require('hasha');
const logger = require('debug');
const readline = require('readline');
const tmp = require('tmp');

const { Transform } = require('stream');
const { parseString } = require('xml2js');

const { DeferredPromise, AsyncQueue, pmap, splitResolveReject } = require('./utils');

const MLST_DIR="/tmp/pubmlst"

function parseAlleleName(allele) {
  try {
    const matches = /([^0-9]*)[-_\.]([0-9]+)/.exec(allele);
    const [gene, st] = matches.slice(1);
    return {gene, st: Number(st)};
  }
  catch (err) {
    logger('error')(`Couldn't parse gene and st from ${allele}`);
    throw err
  }
}

class Metadata {
  _parseAlleleFile(alleleFilePath) {
    logger('trace:metadata:analyse')(`Analysing ${alleleFilePath}`)
    const seqStream = fasta.obj(alleleFilePath);
    const lengths = {};
    const hashes = {};

    const output = new DeferredPromise()

    seqStream.on('data', seq => {
      const allele = seq.id;
      logger('trace:alleleDetails')(`Analysing ${allele} from ${alleleFilePath}`)
      const length = seq.seq.length;
      const hash = hasha(seq.seq.toLowerCase(), {algorithm: 'sha1'});

      lengths[allele] = length;
      hashes[hash] = allele;
    });

    seqStream.on('end', () => {
      logger('debug:alleleDetails')(`Finished reading ${_.keys(lengths).length} alleles from ${alleleFilePath}`);
      output.resolve([lengths, hashes]);
    })

    return output;
  }

  _parseAlleleDetails(allelePaths) {
    const alleleFileResults = _.map(allelePaths, this._parseAlleleFile)
    return Promise.all(alleleFileResults).then(results => {
      const lengths = {};
      const hashes = {};

      _.forEach(results, result => {
        const [singleGeneLengths, singleGeneHashes] = result;
        _.assign(lengths, singleGeneLengths);
        _.assign(hashes, singleGeneHashes);
      })

      return { lengths, hashes }
    })
  }

  _getMostCommonGeneLenghts(lengths) {
    const geneLengthCounts = {}
    _.forEach(_.toPairs(lengths), ([allele, length]) => {
      const { gene } = parseAlleleName(allele);
      (geneLengthCounts[gene] = geneLengthCounts[gene] || {});
      geneLengthCounts[gene][length] = (geneLengthCounts[gene][length] || 0) + 1;
    })
    const mostCommonGeneLengths = {}
    _.forEach(_.keys(geneLengthCounts), gene => {
      const [mostCommonLength, count] = _.maxBy(
        _.toPairs(geneLengthCounts[gene]),
        ([length, count]) => { return count }
      )
      mostCommonGeneLengths[gene] = Number(mostCommonLength);
    })
    return mostCommonGeneLengths;
  }

  _buildProfileRowParser(genes, header) {
    return (row) => {
      const rowObj = _(header)
        .zip(row)
        .fromPairs()
        .value()
      const alleles = _.map(genes, gene => {
        return rowObj[gene];
      })
      const ST = rowObj['ST'];
      return { ST, alleles };
    }
  }

  _getProfiles(options={}) {
    const { profilesPath, genes } = options;
    logger('debug:metadata:profile')(`Loading profile data from ${profilesPath}`)
    const output = new DeferredPromise()
    var rowParser = null;

    const profileData = {};
    const profileFileStream = readline.createInterface({
      input: fs.createReadStream(profilesPath)
    });

    profileFileStream.on('line', line => {
      const row = line.split('\t');
      if (rowParser == null) {
        // This is the header row
        rowParser = this._buildProfileRowParser(genes, row)
      } else {
        const { ST, alleles } = rowParser(row);
        const allelesKey = alleles.join('_');
        profileData[allelesKey] = ST;
      }
    });

    profileFileStream.on('close', () => {
      logger('debug:metadata:profile')(`Found ${_.keys(profileData).length} profiles in ${profilesPath}`)
      output.resolve(profileData);
    });

    return output
  }

  buildMetadata(species, scheme, genes, allelePaths, profilesPath, retrieved) {
    logger('debug:metadata:buildMetadata')(`Building metadata for ${species}`)
    const outputs = {
      species,
      allelePaths,
      genes,
      hashes: new DeferredPromise(),
      lengths: new DeferredPromise(),
      profiles: this._getProfiles({profilesPath, genes}),
      scheme,
      profilesPath,
      commonGeneLengths: new DeferredPromise(),
      retrieved,
    }
    this._parseAlleleDetails(allelePaths)
      .then(({hashes, lengths }) => {
        logger('trace:metadata:buildMetadata')(`Built hashes and lengths for ${species}`)
        outputs.hashes.resolve(hashes);
        outputs.lengths.resolve(lengths);
      })
      .catch('error:metadata:buildMetadata')

    const commonGeneLengths = outputs.commonGeneLengths;
    outputs.lengths
      .then(this._getMostCommonGeneLenghts)
      .then(commonGeneLengths.resolve.bind(commonGeneLengths))
      .then(() => logger('trace:metadata:buildMetadata')(`Found commonest gene lengths for ${species}`))
      .catch('error:metadata:buildMetadata')

    // Some of the values of output are promises.  Instead,
    // we would like to return a Promise to an object which
    // doesn't have any Promises in it.
    return Promise.all(_.values(outputs))
      .then(values => {
        logger('trace:metadata:buildMetadata')(`Resolved promises for metadata for ${species}`)
        return _.fromPairs(_.zip(_.keys(outputs), values))
      })
  }

  writeMetadata(outPath, ...options) {
    return this.buildMetadata(...options).then(data => {
      const { species } = data;
      logger('debug:metadata:write')(`Writing metadata for ${species} to ${outPath}`)
      const jsonData = JSON.stringify(data);
      fs.writeFile(outPath, jsonData, (err, data) => {
        if (err) logger('error')(err);
        logger('debug:metadata:write')(`Wrote metadata for ${species} to ${outPath}`)
      })
      return data
    })
  }
}

class PubMlst extends Metadata {
  constructor(dataDir=MLST_DIR) {
    super();
    const CONCURRENCY = 2;
    this.downloadTokens = new AsyncQueue({contents: _.range(CONCURRENCY)});
    this.dataDir = dataDir
    this.metadataPath = path.join(dataDir, 'metadata.json')
    this.lock = new AsyncLock();
  }

  read(speciesName) {
    const rootMetadata = require(this.metadataPath);
    const speciesMetadataPath = rootMetadata[speciesName].metadataPath;
    return require(speciesMetadataPath);
  }

  update() {
    const allSpeciesMlstMetadata = {};
    return this._getPubMlstMetadata(this.PUBMLST_URL)
      .then(pubMlstMetadata => {
        const latestMetadata = this._latestMetadata(pubMlstMetadata);
        const updatedMetadata = _.map(latestMetadata, (speciesMetadata) => {
          return this._updateSpecies(speciesMetadata);
        })

        const writtenMetadata = pmap(updatedMetadata, data => {
          return this.lock.acquire(this.metadataPath, () => {
            const { species } = data;
            allSpeciesMlstMetadata[species] = data;
            return this._writeRootMetadata(allSpeciesMlstMetadata, this.metadataPath)
          })
        })

        const resolvedRejected = splitResolveReject(writtenMetadata)
        const output = resolvedRejected
          .then(({resolved, rejected}) => {
            logger('debug')(`Finished writing metadata for ${resolved.length} species`)
            logger('error')(`There were ${rejected.length} errors`)
            _.forEach(rejected, p => p.catch(logger('error')))
            return allSpeciesMlstMetadata
          })

        return output
      })
  }

  _latestMetadata(metadata) {
    // Some species have multiple MLST schemes, find the latest one
    const maxVersion = {};
    const latestVersionOfSpeciesData = {};

    _.forEach(metadata, (speciesData) => {
      const nameParts = speciesData.species.split('#');
      const species = nameParts[0];
      const version = Number(nameParts[1] || 0);
      if ((maxVersion[species] || -1) < version) {
        maxVersion[species] = version;
        latestVersionOfSpeciesData[species] = speciesData;
      }
    })

    _(latestVersionOfSpeciesData)
      .toPairs()
      .forEach(([species, speciesData]) => {
        if (species != speciesData.species) {
          logger('debug:update:latest')(`Using ${speciesData.species} for ${species}`);
          speciesData.species = species;
        }
      })

    return _.values(latestVersionOfSpeciesData);
  }

  _writeRootMetadata(metadata, outPath) {
    const jsonData = JSON.stringify(metadata);
    const output = new DeferredPromise()
    fs.writeFile(outPath, jsonData, (err, data) => {
      if (err) output.reject(err);
      logger('debug:metadataWrite')(`Wrote metadata to ${outPath}`)
      output.resolve(outPath)
    })
    return output
  }

  _updateSpecies(speciesData) {
    const { species, scheme, genes, retrieved } = speciesData;
    logger('debug:updateSpecies')(`Updating details for ${species}`);
    const downloadedFiles = this._downloadSpecies(speciesData, this.dataDir)
    const sortedFiles = downloadedFiles.then(({ species, allelePaths, profilesPath }) => {
      return Promise.all(this._sortAlleleSequences(allelePaths))
        .then((allelePaths) => {
          return { species, allelePaths, profilesPath }
        })
    })
    const metadata = sortedFiles.then(({species, allelePaths, profilesPath}) => {
      return this._updateSpeciesMetadata(this.dataDir, species, scheme, genes, allelePaths, profilesPath, retrieved)
    })
    return Promise.all([sortedFiles, metadata]).then(([{ species, allelePaths, profilesPath }, metadataPath]) => {
      return {
        species,
        scheme,
        genes,
        metadataPath,
        retrieved,
      }
    })
  }

  _updateSpeciesMetadata(dataDir, species, scheme, genes, allelePaths, profilesPath, retrieved) {
    const speciesDir = this._speciesDir(species, dataDir);
    const outpath = path.join(speciesDir, 'metadata.json');
    return this.writeMetadata(outpath, species, scheme, genes, allelePaths, profilesPath, retrieved)
      .then(() => outpath);
  }

  _speciesDir(species, dataDir) {
    const speciesDir = species.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '')
    const outDir = path.join(dataDir, speciesDir);
    return outDir;
  }

  _downloadFile(url, downloadPath) {
    logger('trace:pubmlst:download')(`In queue to download ${url} to ${downloadPath}`)
    return this.downloadTokens.shift()
      .then(token => {
        logger('trace:pubmlst:download')(`Downloading ${url} to ${downloadPath} (${token})`)
        return axios.get(url, {responseType: 'stream'})
          .then((response) => {
            return { token, response }
          })
      })
      .then(({token, response}) => {
        const outstream = fs.createWriteStream(downloadPath, {mode: 0o644})
        response.data.pipe(outstream)
        return new Promise((resolve, reject) => {
            outstream.on('close', () => {
              logger('trace:pubmlst:download')(`Downloaded ${url} to ${downloadPath} (${token})`)
              resolve({token, downloadPath});
            })
        })
      })
      .then(response => {
        const { token } = response;
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            resolve(response)
          }, 2000)
        })
      })
      .then(({token, downloadPath}) => {
        this.downloadTokens.push(token)
        return downloadPath
      })
  }

  _downloadSpecies(speciesMetadata, dataDir) {
    const { species, scheme } = speciesMetadata;
    const speciesDir = this._speciesDir(species, dataDir)
    const alleleDir = path.join(speciesDir, 'alleles');
    const profileDir = path.join(speciesDir, 'profiles');
    const { loci } = speciesMetadata.database;

    const profilesPath = mkdirp(profileDir, {mode: 0o755})
      .then(() => {
        const { url } = speciesMetadata.database.profiles;
        const filename = `${scheme}.txt`;
        const downloadPath = path.join(profileDir, filename);
        return this._downloadFile(url, downloadPath)
      })
    profilesPath.then(filePath => logger('debug:profilesPath')(`${scheme} => ${filePath}`))

    const allelePaths = profilesPath
      .then(() => mkdirp(alleleDir, {mode: 0o755}))
      .then(() => {
        return Promise.all(_.map(loci, ({ locus, url }) => {
          const downloadPath = path.join(alleleDir, locus) + '.tfa';
          return this._downloadFile(url, downloadPath)
        }))
      })
    allelePaths.then(filePath => logger('debug:allelePaths')(`${scheme} => ${filePath}`))

    return Promise.all([allelePaths, profilesPath])
      .then(([allelePaths, profilesPath]) => {
        return { species, allelePaths, profilesPath }
      })
  }

  _getPubMlstMetadata(url) {
    return axios.get(url)
      .then(response => {
        return new Promise((resolve, reject) => {
            parseString(response.data, (err, result) => {
              if (err) reject(err);
              resolve(result);
            });
        })
      })
      .then(data => {
        return data.data.species
      })
      .then(species => {
        return _.map(species, this._parseDbConfig);
      })
  }

  _parseDbConfig(data) {
    const species = data['_'].trim();
    const database = data.mlst[0].database[0];
    const url = database.url[0];
    const retrieved = database.retrieved[0];
    const profiles = database.profiles[0];
    const profiles_count = Number(profiles.count[0]);
    const profiles_url = profiles.url[0];
    const loci = _.map(database.loci[0].locus, parseLocus);

    function parseLocus(locusData) {
      const locus = locusData['_'].trim();
      const url = locusData.url[0];
      return { locus, url };
    }

    const scheme = /([^\/]+)\.txt$/.exec(profiles_url)[1];
    const genes = _.map(loci, locus => { return locus.locus });

    return {
      species,
      scheme,
      genes,
      retrieved,
      url,
      database: {
        profiles: {
          count: profiles_count,
          url: profiles_url,
        },
        loci,
      }
    }
  }

  _sortAlleleSequences(allelePaths) {
    logger('trace:sortAlleleSequences:sorting')(allelePaths)
    function sortAlleleFile(allelePath) {
      return this._sortFastaBySequenceLength(allelePath)
        .then(() => {
          logger('trace:sortAlleleSequences:sorted')(allelePath)
          return allelePath;
        })
    }
    const sorted = _.map(allelePaths, sortAlleleFile.bind(this))
    const updatedFastas = Promise.all(sorted);
    updatedFastas.then((paths) => {
      logger('debug:sortAlleleSequences:sorted')(`Sorted ${paths.length} allele files`)
    })
    return sorted;
  }

  _sortFastaBySequenceLength(fastaPath) {
    const sequences = [];
    const seqStream = fasta.obj(fastaPath);

    const output = new DeferredPromise();
    const onDone = () => {
      output.resolve.bind(output)(fastaPath);
    }

    const sortSequences = () => {
      // Sorts the sequences so that you get a good mix of lengths
      // For example, if sequences == [{length: 5}, {length: 5}, {length: 5}, {length: 3}, {length: 3}, {length: 1}]
      // this returns: [{length: 5}, {length: 3}, {length: 1}, {length: 5}, {length: 3}, {length: 5}]
      const groupedByLength = _.reduce(sequences, (result, seq) => {
        (result[seq.length] = result[seq.length] || []).push(seq);
        return result;
      }, {});
      const lengths = _.keys(groupedByLength).sort();
      const sortedSequences = _(groupedByLength) // {455: [seq, ...], 460: [seq, ...], ...}
        .toPairs() // [[455, [seq, ...]], [460, [seq, ...]], ...]
        .sortBy(([length, seqs]) => { return -length }) // [[477, [seq, ...]], [475, [seq, ...]], ...]
        .map(([length, seqs]) => { return seqs }) // [[seq1, seq2, ...], [seq11, seq12, ...], ...]
        .thru(seqs => _.zip(...seqs)) // [[seq1, seq11, ...], [seq2, undefined, ...], ...]
        .flatten() // [seq1, seq11, ..., seq2, undefined, ...]
        .filter(el => { return typeof(el) != 'undefined' }) // [seq1, seq11, ..., seq2, ...]
        .value()
      return { lengths, sortedSequences };
    }

    seqStream.on('data', seq => {
      seq.length = seq.seq.length;
      sequences.push(seq);
    });

    seqStream.on('end', () => {
      tmp.file((err, tempFastaPath, fd, callback) => {
        const { lengths, sortedSequences } = sortSequences();
        const tempStream = fs.createWriteStream(tempFastaPath);
        const output = new FastaString();
        output.pipe(tempStream)
        _.forEach(sortedSequences, s => {
          output.write(s);
        })

        output.end()
        tempStream.on('close', () => {
          logger('trace:sortFastaBySequenceLength:rename')([tempFastaPath, fastaPath]);
          fs.rename(tempFastaPath, fastaPath, onDone);
        })
      })
    })

    return output;
  }
}

class FastaString extends Transform {
  constructor(options={}) {
    options.objectMode = true;
    super(options)
  }

  _transform(chunk, encoding, callback) {
    const output=`>${chunk.id}\n${chunk.seq}\n`;
    this.push(output);
    callback();
  }
}

module.exports = { parseAlleleName, PubMlst, FastaString };
