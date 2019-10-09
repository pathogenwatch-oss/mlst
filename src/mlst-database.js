const Promise = require("bluebird");
const logger = require("debug");
const fs = require("fs");
const hasha = require("hasha");
const _ = require("lodash");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const readline = require("readline");
const { promisify } = require("util");
const zlib = require("zlib");

const {
  reverseCompliment,
  DeferredPromise,
  loadSequencesFromStream
} = require("./utils");

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const existsAsync = promisify(fs.exists);
const gzipAsync = promisify(zlib.gzip);

const DEFAULT_INDEX_DIR = 'index_dir'

async function writeJsonAsync(outputPath, data, options) {
  const jsonData = JSON.stringify(data);
  await promisify(fs.writeFile)(outputPath, jsonData, options);
  logger("cgps:debug:writeJson")(`Wrote data to ${outputPath}`);
  return outputPath;
}

async function readJsonAsync(outputPath) {
  const content = await promisify(fs.readFile)(outputPath);
  return JSON.parse(content);
}

async function readGenes(genesFile) {
  const contents = await readFileAsync(genesFile, { encoding: 'utf8' });
  const genes = _.filter(contents.split('\n'), line => line);
  genes.sort();
  return genes;
}

class Scheme {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.indexDir = options.indexDir;
    this.schemePath = options.schemePath;
    this.schemeDir = path.join(this.indexDir, this.schemePath)
    this.alleleLookupPrefixLength = 20;
    this.metadata = options.metadata;
    const genesFile = path.join(this.dataDir, this.schemePath, '.bin', 'genes.txt');
    this.genes = readGenes(genesFile);
  }

  async alleles(gene) {
    const allelesPath = path.join(this.dataDir, this.schemePath, `${gene}.fa.gz`);
    const rawSeqs = await this._readFasta(allelesPath);
    return _.map(rawSeqs, s => {
      const { id, seq, length } = s;
      return { gene, st: Number(id), length, seq };
    });
  }

  _rowParserFactory(genes, header) {
    // Returns a function which maps a row to an object
    return row => {
      const rowObj = _(header)
        .zip(row)
        .fromPairs()
        .value();
      const alleles = _.map(genes, gene => rowObj[gene]);
      const { ST: st } = rowObj;
      return { st, alleles };
    };
  }

  async profiles() {
    const profilesPath = path.join(this.dataDir, this.schemePath, 'profiles.tsv');
    if (!(await existsAsync(profilesPath))) return undefined;

    const genes = await this.genes;
    let rowParser = null;
    const output = new DeferredPromise();
    const profiles = {};

    readline
      .createInterface({
        input: fs.createReadStream(profilesPath)
      })
      .on("line", line => {
        const row = line.split("\t");
        if (rowParser === null) {
          // This is the header row
          rowParser = this._rowParserFactory(genes, row);
        } else {
          const { st, alleles } = rowParser(row);
          const allelesKey = alleles.join("_");
          profiles[allelesKey] = st;
        }
      })
      .on("close", () => {
        const nProfiles = _.keys(profiles).length;
        logger("cgps:trace:index")(`Found ${nProfiles} in ${profilesPath}`);
        output.resolve(profiles);
      })
      .on("error", err => {
        output.reject(err);
      });
    return output.promise;
  }

  async index(maxSeqs = 0) {
    // maxSeqs is the maximum number of sequences for each gene
    await mkdirp(this.schemeDir, { mode: 0o755 });

    const alleleLookup = {};
    const genes = await this.genes;
    const allelePaths = {};
    const lengths = {};
    const alleleCounts = {};
    await Promise.map(
      genes,
      async gene => {
        lengths[gene] = {};
        const alleles = await this.alleles(gene); // map of allele_id to allele object
        const sortedAlleles = this.sort(alleles);
        alleleCounts[gene] = sortedAlleles.length;
        let allelePath;
        if (maxSeqs > 0) {
          allelePath = await this.write(
            gene,
            sortedAlleles.slice(0, maxSeqs)
          );
        } else {
          allelePath = await this.write(gene, sortedAlleles);
        }
        allelePaths[gene] = allelePath;
        _.forEach(alleles, allele => {
          _.forEach(this.hash(allele), ([prefix, ...details]) => {
            // Looks like
            // {
            //   <PREFIX>: [
            //     [ <GENE> <ST> <LENGTH> <SHA1 HASH>  <REVERSE COMPLIMENT> ],
            //     [ <GENE> <ST> <LENGTH> <SHA1 HASH>  <REVERSE COMPLIMENT> ],
            //     ... more ...
            //   ],
            //   <ANOTHER PREFIX>: [
            //     ... more ...
            //   ],
            //   ... more ...
            // }
            (alleleLookup[prefix] = alleleLookup[prefix] || []).push([
              gene,
              ...details
            ]);
          });
          lengths[gene][allele.st] = allele.length;
        });
        logger("cgps:trace:index")(`Hashed ${alleles.length} alleles of ${gene}`);
        return;
      },
      { concurrency: 3 }
    );

    const totalAlleles = _(alleleCounts)
      .values()
      .sum();
    this.metadata = this.metadata || {};
    const metadata = {
      ...this.metadata,
      genes,
      allelePaths,
      alleleCounts,
      lengths,
      schemeSize: (await this.genes).length,
      alleleLookup,
      alleleLookupPrefixLength: this.alleleLookupPrefixLength,
      profiles: await this.profiles()
    };
    const metadataPath = path.join(this.schemeDir, "metadata.json");
    await writeJsonAsync(metadataPath, metadata);
    logger("cgps:info")(
      `Indexed ${totalAlleles} alleles from ${
        genes.length
      } genes into ${metadataPath}`
    );
    return path.join(this.schemePath, "metadata.json");
  }

  sort(alleles) {
    // Sorts the sequences so that you get a good mix of lengths
    // For example, if sequences == {1: [A1, B1, C1], 3: [D3, E3], 4: [F4], 5:[G5, H5, I5, J5]}
    // this returns: [G5, F4, D3, A1, H5, E3, B1, I5, C1, J5]
    return _(alleles)
      .groupBy("length") // {455: [seq, ...], 460: [seq, ...], ...}
      .toPairs() // [[455, [seq, ...]], [460, [seq, ...]], ...]
      .sortBy(([length]) => -length) // [[477, [seq, ...]], [475, [seq, ...]], ...]
      .map(([, seqs]) => _.sortBy(seqs, "st")) // [[seq1, seq2, ...], [seq11, seq12, ...], ...]
      .thru(seqs => _.zip(...seqs)) // [[seq1, seq11, ...], [seq2, undefined, ...], ...]
      .flatten() // [seq1, seq11, ..., seq2, undefined, ...]
      .filter(el => typeof el !== "undefined") // [seq1, seq11, ..., seq2, ...]
      .value();
  }

  hash(allele) {
    const { st, length, seq } = allele;
    const hash = hasha(seq, { algorithm: "sha1" });
    const prefix = seq.slice(0, this.alleleLookupPrefixLength);

    const complimentarySequence = reverseCompliment(seq);
    const rcHash = hasha(complimentarySequence, { algorithm: "sha1" });
    const rcPrefix = complimentarySequence.slice(
      0,
      this.alleleLookupPrefixLength
    );

    return [
      [prefix, st, length, hash, false],
      [rcPrefix, st, length, rcHash, true]
    ];
  }

  async write(gene, alleles) {
    const outpath = path.join(this.schemeDir, `${gene}.fa.gz`);
    const contents = _(alleles)
      .map(allele => `>${allele.gene}_${allele.st}\n${allele.seq}\n`)
      .join("");
    const zippedContent = await gzipAsync(contents)
    await writeFileAsync(outpath, zippedContent);
    logger("cgps:trace:index")(
      `Wrote ${alleles.length} alleles for ${gene} to ${outpath}`
    );
    return path.join(this.schemePath, `${gene}.fa.gz`);
  }

  async _readFasta(fastaPath) {
    const stream = fs.createReadStream(fastaPath).pipe(zlib.createGunzip());
    const rawSeqs = await loadSequencesFromStream(stream);
    return _.map(rawSeqs, (seq, id) => ({
      id,
      seq: seq.toLowerCase(),
      length: seq.length
    }));
  }
}

async function updateMetadata(dataDir, update) {
  const metadataPath = path.join(dataDir, "metadata.json");
  let metadata = {}
  try {
    metadata = await readJsonAsync(metadataPath);
  } catch (err) {
    await mkdirp(dataDir, { mode: 0o755 });
  }
  const updatedMetadata = { ...metadata, ...update }
  await writeJsonAsync(metadataPath, updatedMetadata)
  return updatedMetadata
}

async function readScheme(taxid, indexDir=DEFAULT_INDEX_DIR) {
  const metadata = await readJsonAsync(path.join(indexDir, 'metadata.json'));
  const schemeMetadata = metadata[taxid] || {};
  const schemeMetadataPath = schemeMetadata.path;
  if (schemeMetadataPath === undefined) return undefined;

  try {
    // Links in the schemeMetadata are relative to the indexDir
    const schemeDetails = await readJsonAsync(path.join(indexDir, schemeMetadataPath));
    for (const allele of Object.keys(schemeDetails.allelePaths)) {
      schemeDetails.allelePaths[allele] = path.join(indexDir, schemeDetails.allelePaths[allele]);
    }
    return schemeDetails
  } catch (err) {
    return undefined;
  }
}

function parseAlleleName(allele) {
  try {
    const matches = /^(.+)_([0-9]+(\.[0-9]+)?)$/.exec(allele);
    const [gene, st] = matches.slice(1);
    return { gene, st: Number(st) };
  } catch (err) {
    logger("cgps:error")(`Couldn't parse gene and st from ${allele}`);
    throw err;
  }
}

async function readSchemeUpdatedDate(dir) {
  try {
    return await readFileAsync(path.join(dir, 'updated.txt'));
  } catch (err) {
    return "0"
  }
}

async function main() {
  const yargs = require("yargs")
  const { argv } = yargs
    .usage('Usage: $0 [--type FILTER_BY_TYPE] [--scheme SPECIFIC_SCHEME] [--index WHERE_TO_PUT_THE_INDEX] --database WHERE_TO_FIND_SCHEMES')
    .option('type', {
      alias: 't',
      describe: 'type of schemes to index',
      type: 'string'
    })
    .option('scheme', {
      alias: 's',
      describe: 'shortname of the scheme to build',
      type: 'string',
      array: true
    })
    .option('index', {
      alias: 'i',
      describe: 'directory for the index',
      type: 'string',
      default: DEFAULT_INDEX_DIR
    })
    .option('database', {
      alias: 'd',
      describe: 'directory with the scheme data',
      type: 'string',
      demandOption: true
    })
    .option('max-sequences', {
      alias: 'n',
      describe: 'number of complete alleles to index',
      type: 'number',
      default: 0
    })
    .help('h')
    .alias('h', 'help')

  let { schemes } = await readJsonAsync(path.join(argv.database, 'schemes.json'))
  await mkdirp(argv.index)
  if (argv.scheme) {
    schemes = _.filter(schemes, s => argv.scheme.includes(s.shortname))
    const found = new Set(_.map(schemes, 'shortname'))
    for (const scheme of argv.scheme) {
      if (!found.has(scheme)) throw Error(`Could not find ${scheme}`)
    }
  }
  if (argv.type) {
    schemes = _.filter(schemes, s => s.type === argv.type);
  }
  logger('cgps:info')(`Found ${schemes.length} schemes`)

  let latestSchemeUpdate = await readSchemeUpdatedDate(argv.index)

  for (const schemeData of schemes) {
    const { path: schemePath, targets, ...metadata } = schemeData;
    const { name: schemeName, url, shortname, type } = metadata;
    const scheme = new Scheme({
      dataDir: argv.database,
      indexDir: argv.index,
      schemePath,
      metadata
    })
    const maxSeqs = argv.n
    const schemeIndexPath = await scheme.index(maxSeqs)
    const update = {}
    for (const { name: species, taxid } of targets) {
      update[taxid] = {
        path: schemeIndexPath,
        species,
        schemeName,
        url,
        type,
        shortname,
        maxSeqs
      }
      logger('cgps:info')(`Added scheme for ${taxid}`);
    }
    await updateMetadata(argv.index, update)
    const schemeUpdated = await readSchemeUpdatedDate(scheme.schemeDir);
    latestSchemeUpdate = schemeUpdated > latestSchemeUpdate ? schemeUpdated : latestSchemeUpdate;
  }

  await writeFileAsync(path.join(argv.index, 'updated.txt'), latestSchemeUpdate)
}

module.exports = {
  readScheme,
  parseAlleleName,
  Scheme
}

if (require.main === module) {
  const { fail } = require("./utils");

  process.on("unhandledRejection", reason =>
    fail("unhandledRejection")(reason)
  );

  main()
    .then(() => logger('cgps:info')('Indexing complete'))
    .catch(err => fail("error")(err))
}
