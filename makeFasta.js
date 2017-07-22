const _ = require('lodash');
const { Transform, Readable } = require('stream');
const fasta = require('bionode-fasta');
const fs = require('fs');
const path = require('path');
const logger = require('debug');

FASTA_DIR="/code/pubmlst/Staphylococcus_aureus/alleles";
FASTA=`${FASTA_DIR}/arcC.tfa`;
// const fastaStream = fasta.obj(FASTA);

class FastaLength extends Transform {
  constructor(options={}) {
    options.objectMode = true;
    super(options)
  }

  _transform(chunk, encoding, callback) {
    chunk.length = chunk.seq.length;
    this.push(chunk);
    callback()
  }
}

class FastaHead extends Transform {
  constructor(options={}) {
    options.objectMode = true;
    super(options)
  }

  _transform(chunk, encoding, callback) {
    const after = {id: chunk.id, seq: chunk.seq.slice(0, 10)};
    this.push(after);
    callback()
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


class Aggregator extends Transform {
  constructor(options={}) {
    super(options)
  }

  _transform(chunk, encoding, callback) {
    this.push(chunk);
    callback();
  }
}

function readAllelesFromDir(dir, maxSeqs) {
  const aggregator = new Aggregator({objectMode: true});
  fs.readdir(dir, (err, files) => {
    _.forEach(files, file => {
      var count = 0;
      const fastaPath = path.join(FASTA_DIR, file)
      const fastaFile = fasta.obj(fastaPath)
      fastaFile.on('data', seq => {
        seq.path = fastaPath;
        aggregator.write(seq);
        count++;
        if (count >= maxSeqs) {
          // fastaFile.pause();
          fastaFile.destroy('Read enough sequences');
        }
      })
    })
  });
  aggregator.on('close', logger('agg:close'))
  aggregator.on('end', logger('agg:end'))
  aggregator.on('error', logger('agg:error'))
  return aggregator;
}

readAllelesFromDir(FASTA_DIR, 5).pipe(new FastaLength).pipe(new FastaHead).pipe(new FastaString()).pipe(process.stdout);
// fastaStream.pipe(new FastaHead()).on('data', logger('head'));
