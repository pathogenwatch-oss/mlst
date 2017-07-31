'use strict';

const _ = require('lodash');
const { Transform } = require('stream');
const fasta = require('bionode-fasta');
const fs = require('fs');
const path = require('path');
const logger = require('debug');
const hasha = require('hasha');
const tmp = require('tmp');
const readline = require('readline');

const MLST_DIR="/tmp/pubmlst"

class Metadata {
  constructor(species) {
    this.species = species;
    this.alleleFiles = this.getAlleleFiles(species);
    this.geneNames = this.alleleFiles.then(this.getGenes);
    this.hashes = new Promise((resolve, reject) => {
      this.onHashes = resolve;
    })
    this.lengths = new Promise((resolve, reject) => {
      this.onLengths = resolve
    })
    this.commonGeneLengths = new Promise((resolve, reject) => {
      this.onCommonGeneLengths = resolve
    })
    this.alleleFiles
      .then(this.parseAlleleDetails)
      .then(({hashes, lengths, mostCommonGeneLengths }) => {
        this.onHashes(hashes);
        this.onLengths(lengths);
        this.onCommonGeneLengths(mostCommonGeneLengths);
        return {hashes, lengths, mostCommonGeneLengths };
      })
    this.profilePath = new Promise((resolve, reject) => {
      this.onProfilePath = resolve;
    });
    this.scheme = new Promise((resolve, reject) => {
      this.onScheme = resolve
    })
    this.getProfileSchemeAndPath(species)
      .then(({profilePath, scheme}) => {
        logger('tmp')({profilePath, scheme})
        this.onProfilePath(profilePath);
        this.onScheme(scheme);
        return {profilePath, scheme};
      })
    this.profiles = Promise.all([this.profilePath, this.geneNames])
      .then(([profilePath, genes]) => {
        return {profilePath, genes}
      })
      .then(this.getProfiles)
  }

  getAlleleFiles(species) {
    const alleleDir=path.join(MLST_DIR, species.replace(' ', '_'), 'alleles');
    const geneRegex = /(.+)\.tfa$/;
    return new Promise((resolve, reject) => {
      fs.readdir(alleleDir, (err, files) => {
        if (err) reject(err);
        const paths = _(files)
          .filter(f => {
            return geneRegex.test(f)
          })
          .map(f => {
            return path.join(alleleDir, f);
          })
          .value();
        logger('debug:alleleFiles')(`Found ${paths.length} allele files for ${species}`);
        logger('trace:alleleFiles')(paths);
        resolve(paths);
      });
    });
  }

  getGenes(alleleFiles) {
    const geneRegex = /(.+)\.tfa$/;
    const genes = _(alleleFiles)
      .map(f => {
        return path.basename(f)
      }) // File names
      .map(f => {
        const match = geneRegex.exec(f);
        return match ? match[1] : null;
      }) // Remove the extension if it's .tfa
      .filter(gene => {
        return (gene != null);
      }) // Remove null entries (i.e. files not ending in .tfa)
      .value()
      .sort() // Sort them alphabetically
    logger('debug:genes')(`Found ${genes.length} genes`)
    logger('trace:genes')(genes)
    return genes
  }

  parseAlleleDetails(alleleFiles) {
    const analyseAlleleFile = (path) => {
      logger('analyse')(`Analysing ${path}`)
      const seqStream = fasta.obj(path);
      const lengths = {};
      const hashes = {};

      var onComplete;
      const output = new Promise((resolve, reject) => {
        onComplete = resolve;
      });

      seqStream.on('data', seq => {
        const allele = seq.id;
        logger('trace:alleleDetails')(`Analysing ${allele} from ${path}`)
        const length = seq.seq.length;
        const hash = hasha(seq.seq.toLowerCase(), {algorithm: 'sha1'});

        lengths[allele] = length;
        hashes[hash] = allele;
      });

      seqStream.on('end', () => {
        logger('debug:alleleDetails')(`Finished reading ${_.keys(lengths).length} alleles from ${path}`);
        onComplete([lengths, hashes]);
      })

      return output;
    }

    return Promise.all(_.map(alleleFiles, analyseAlleleFile)).then(metadata => {
      return _.reduce(metadata, ([totalLengths, totalHashes], [lengths, hashes]) => {
        return [_.assign(totalLengths, lengths), _.assign(totalHashes, hashes)]
      })
    }).then(([lengths, hashes]) => {
      const lengthCounts = _.reduce(_.toPairs(lengths), (results, [allele, length]) => {
        const gene = allele.split('_').slice(0,-1).join('_');
        (results[gene] = results[gene] || {});
        results[gene][length] = (results[gene][length] || 0) + 1;
        return results;
      }, {})
      const mostCommonGeneLengths = _(lengthCounts)
        .toPairs()
        .map(([gene, lengths]) => {
          const [mostCommonLength, count] = _.maxBy(
            _.toPairs(lengths),
            ([length, count]) => { return count }
          )
          return [gene, mostCommonLength]
        })
        .fromPairs()
        .value()
      return { lengths, hashes, mostCommonGeneLengths };
    })
  }

  getProfileSchemeAndPath(species) {
    const profileDir=path.join(MLST_DIR, species.replace(' ', '_'), 'profiles');
    return new Promise((resolve, reject) => {
      fs.readdir(profileDir, (err, files) => {
        if (err) reject(err);
        const textRegex = /(.+)\.txt$/;
        const profilePaths = _(files)
          .map(f => {
            const match = textRegex.exec(f)
            return match ? path.join(profileDir, f) : null
          })
          .filter(path => {
            return !!path;
          })
          .value()
        if (profilePaths.length != 1) {
          const paths = JSON.stringify(_.values(profilePaths));
          reject(`Expected ${species} to have one profile, found '${paths}'`)
        } else {
          logger('debug:profilePath')(`Found profile file ${profilePaths[0]} for ${species}`)
          const profilePath = profilePaths[0];
          const scheme = path.basename(profilePath, '.txt')
          resolve({ profilePath, scheme });
        }
      });
    });
  }

  getProfiles(options={}) {
    const { profilePath, genes } = options;
    logger('debug:profile')(`Loading profile data from ${profilePath}`)
    var onClose, onError;
    const output = new Promise((resolve, reject) => {
      onClose = resolve;
      onError = reject;
    })

    var header = [];
    const profileData = {};

    const parseRow = (row) => {
      // logger('tmp')([header, row])
      const rowObj = _(header)
        .zip(row)
        .fromPairs()
        .value()

      // logger('tmp:rowObj')(rowObj);
      const alleles = _.map(genes, gene => {
        return rowObj[gene];
      })
      const ST = rowObj['ST'];

      return { ST, alleles };
    }

    const profileFileStream = readline.createInterface({
      input: fs.createReadStream(profilePath)
    });

    profileFileStream.on('line', line => {
      const row = line.split('\t');
      if (header.length == 0) {
        header = row;
      } else {
        const { ST, alleles } = parseRow(row);
        logger('trace:profile')({ ST, alleles })
        const allelesKey = alleles.join('_');
        profileData[allelesKey] = ST;
      }
    });

    profileFileStream.on('close', () => {
      logger('debug:profile')(`Found ${_.keys(profileData).length} profiles in ${profilePath}`)
      onClose(profileData);
    });

    return output
  }

  data() {
    return Promise.all([
      this.species, this.alleleFiles,
      this.geneNames, this.hashes,
      this.lengths, this.profiles,
      this.scheme, this.profilePath,
      this.commonGeneLengths
    ]).then(([
      species, alleleFiles,
      genes, hashes,
      lengths, profiles,
      scheme, profilePath,
      commonGeneLengths
    ]) => {
      logger('debug:metadata')(`Returning data on ${genes.length} genes from ${species}`)
      return { species, alleleFiles, genes, hashes, lengths, profiles, scheme, profilePath, commonGeneLengths }
    })
  }

  write(path) {
    return this.data().then(data => {
      const jsonData = JSON.stringify(data);
      const { species } = data;
      fs.writeFile(path, jsonData, (err, data) => {
        if (err) logger('error')(err);
        logger('debug:metadataWrite')(`Wrote metadata for ${species} to ${path}`)
      })
      return data
    })
  }
}

function readMetadata(species) {
  const metadataPath=path.join(MLST_DIR, species.replace(' ', '_'), 'metadata');
  return require(metadataPath);
}

function sortAlleleSequences(alleleFiles) {
  const sorted = _.map(alleleFiles, path => {
    const onDone = () => {
      logger('trace:sorted')(path)
      return path
    }
    logger('trace:sorting')(path)
    return sortFastaBySequenceLength(path).then(onDone)
  })
  const updatedFastas = Promise.all(sorted);
  updatedFastas.then((paths) => {
    logger('debug:sorted')(`Sorted ${paths.length} allele files`)
  })
  return updatedFastas;
}

function sortFastaBySequenceLength(path) {
  const sequences = [];
  const seqStream = fasta.obj(path);

  var onDone;
  const output = new Promise((resolve, reject) => {
    onDone = resolve;
  })

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
    tmp.file((err, tempPath, fd, callback) => {
      // logger('seqs')(sequences.slice(0,5));
      const { lengths, sortedSequences } = sortSequences();
      // logger('seqs:sorted')(sortedSequences.slice(0,5));
      const tempStream = fs.createWriteStream(tempPath);
      const output = new FastaString();
      output.pipe(tempStream)
      _.forEach(sortedSequences, s => {
        output.write(s);
      })

      output.end()
      logger('rename')([tempPath, path]);
      fs.rename(tempPath, path, onDone);
    })
  })

  return output;
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

module.exports = { Metadata, readMetadata, sortAlleleSequences, FastaString };
