'use strict';

const _ = require('lodash');
const { Transform } = require('stream');
const fasta = require('bionode-fasta');
const fs = require('fs');
const path = require('path');
const logger = require('debug');
const hasha = require('hasha');

const MLST_DIR="/code/pubmlst"

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

module.exports = { listAlleleFiles, readMetadata, writeMetadata, FastaString };
