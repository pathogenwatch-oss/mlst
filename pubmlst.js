'use strict';

const _ = require('lodash');
const { Transform } = require('stream');
const fasta = require('bionode-fasta');
const fs = require('fs');
const path = require('path');
const logger = require('debug');
const hasha = require('hasha');
const tmp = require('tmp');

const MLST_DIR="/tmp/pubmlst"

function listAlleleFiles(species) {
  const alleleDir=path.join(MLST_DIR, species.replace(' ', '_'), 'alleles');
  return new Promise((resolve, reject) => {
    fs.readdir(alleleDir, (err, files) => {
      if (err) reject(err);
      const paths = _.map(files, f => {
        return path.join(alleleDir, f);
      });
      logger('paths')(paths)
      resolve(paths);
    });
  });
}

function buildMetadata(species) {
  const alleleFiles = listAlleleFiles(species)
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
      logger('trace')(`Analysing ${allele} from ${path}`)
      const length = seq.seq.length;
      const hash = hasha(seq.seq.toLowerCase(), {algorithm: 'sha1'});

      lengths[allele] = length;
      hashes[hash] = allele;
    });

    seqStream.on('end', () => {
      logger('analyse')(`Finished reading ${_.keys(lengths).length} alleles from ${path}`);
      onComplete([lengths, hashes]);
    })


    return output;
  }

  return alleleFiles.then(paths => {
    return Promise.all(_.map(paths, analyseAlleleFile))
  }).then(metadata => {
    logger('metadata')(`Got ${metadata.length} bits of metadata`)
    return _.reduce(metadata, ([totalLengths, totalHashes], [lengths, hashes]) => {
      return [_.assign(totalLengths, lengths), _.assign(totalHashes, hashes)]
    })
  }).then(([lengths, hashes]) => {
    return {
      species,
      lengths,
      hashes,
    }
  })
}

function readMetadata(species) {
  const hashPath=path.join(MLST_DIR, species.replace(' ', '_'), 'metadata');
  return require(hashPath);
}

function writeMetadata(path, species) {
  return buildMetadata(species).then(metadata => {
    const json = JSON.stringify(metadata);
    fs.writeFile(path, json, (err, data) => {
      if (err) logger('error')(err);
      logger('debug')(`Wrote metadata for ${species} to ${path}`)
    })
    return metadata;
  });
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

function sortAlleleSequences(species) {
  const alleleFiles = listAlleleFiles(species)
  const updatedFastas = alleleFiles.then(paths => {
    const sorted = _.map(paths, path => {
      const onDone = () => {
        logger('sorted')(path)
        return path
      }
      logger('sorting')(path)
      return sortFastaBySequenceLength(path).then(onDone)
    })
    return Promise.all(sorted);
  })
  updatedFastas.then((paths) => {
    logger('sorted:all')(`Sorted ${paths.length} allele files`)
  })
  return updatedFastas;
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

module.exports = { listAlleleFiles, readMetadata, writeMetadata, sortAlleleSequences, FastaString };
