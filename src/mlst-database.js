const Promise = require("bluebird");
const es = require("event-stream");
const _ = require("lodash");
const fasta = require("bionode-fasta");
const fs = require("fs");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const hasha = require("hasha");
const logger = require("debug");
const readline = require("readline");
const slugify = require("slugify");
const tmp = require("tmp");
const { promisify } = require("util");
const { Unzip } = require("zlib");

const { Transform } = require("stream");
const { parseString } = require("xml2js");

const {
  DeferredPromise,
  parseAlleleName,
  reverseCompliment
} = require("./utils");
const { urlToPath } = require("../download_src/download");

const MLST_DIR = "/opt/mlst/databases";
const ALLELE_LOOKUP_PREFIX_LENGTH = 20;

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

async function readJson(inputPath) {
  const jsonString = await promisify(fs.readFile)(inputPath);
  return JSON.parse(jsonString);
}

async function writeJson(outputPath, data, options) {
  const jsonData = JSON.stringify(data);
  await promisify(fs.writeFile)(outputPath, jsonData, options);
  logger("debug:writeJson")(`Wrote data to ${outputPath}`);
  return outputPath;
}

class Metadata {
  constructor(dataDir = MLST_DIR) {
    this.dataDir = dataDir;
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

  _sortSequences(sequencesByLength) {
    // Sorts the sequences so that you get a good mix of lengths
    // For example, if sequences == {1: [A1, B1, C1], 3: [D3, E3], 4: [F4], 5:[G5, H5, I5, J5]}
    // this returns: [G5, F4, D3, A1, H5, E3, B1, I5, C1, J5]
    const sortedSequences = _(sequencesByLength) // {455: [seq, ...], 460: [seq, ...], ...}
      .toPairs() // [[455, [seq, ...]], [460, [seq, ...]], ...]
      .sortBy(([length]) => -length) // [[477, [seq, ...]], [475, [seq, ...]], ...]
      .map(([, seqs]) => seqs) // [[seq1, seq2, ...], [seq11, seq12, ...], ...]
      .thru(seqs => _.zip(...seqs)) // [[seq1, seq11, ...], [seq2, undefined, ...], ...]
      .flatten() // [seq1, seq11, ..., seq2, undefined, ...]
      .filter(el => typeof el !== "undefined") // [seq1, seq11, ..., seq2, ...]
      .value();
    return sortedSequences;
  }

  async _indexAlleleFile(inputPath, outputPath) {
    logger("trace:indexAlleles")(`Analysing ${inputPath}`);
    const seqStream = fasta.obj(inputPath);
    seqStream.pause();
    const alleleLookup = {};
    const sequencesByLength = {};

    const whenSequencesRead = new DeferredPromise();

    seqStream.on("data", seq => {
      const allele = seq.id;
      const sequence = seq.seq.toLowerCase();
      const length = seq.seq.length;
      const hash = hasha(sequence, { algorithm: "sha1" });
      const prefix = sequence.slice(0, ALLELE_LOOKUP_PREFIX_LENGTH);
      (alleleLookup[prefix] = alleleLookup[prefix] || []).push([
        allele,
        length,
        hash,
        false
      ]);

      const complimentarySequence = reverseCompliment(sequence);
      const rcHash = hasha(complimentarySequence, { algorithm: "sha1" });
      const rcPrefix = complimentarySequence.slice(
        0,
        ALLELE_LOOKUP_PREFIX_LENGTH
      );
      (alleleLookup[rcPrefix] = alleleLookup[rcPrefix] || []).push([
        allele,
        length,
        rcHash,
        true
      ]);

      (sequencesByLength[length] = sequencesByLength[length] || []).push(seq);
    });

    seqStream.on("end", () => {
      logger("trace:indexAlleles")(
        `Finished reading alleles from ${inputPath}`
      );
      whenSequencesRead.resolve(alleleLookup);
    });
    seqStream.resume();

    await whenSequencesRead;
    const sortedSequences = this._sortSequences(sequencesByLength);
    const whenSequencesWritten = new DeferredPromise();

    const outputFile = fs.createWriteStream(outputPath, { mode: 0o644 });
    const fastaStream = new FastaString();
    fastaStream.pipe(outputFile);
    _.forEach(sortedSequences, s => {
      fastaStream.write(s);
    });

    fastaStream.end();
    outputFile.on("close", () => {
      logger("trace:indexAlleles")(`Written sorted alleles to ${outputPath}`);
      whenSequencesWritten.resolve(alleleLookup);
    });

    return whenSequencesWritten;
  }

  async _indexAlleles(inputAllelePaths, genes, schemeDir) {
    const alleleDir = path.join(schemeDir, "alleles");
    await mkdirp(alleleDir, { mode: 0o755 });
    const allelePaths = _.map(
      genes,
      gene => `${path.join(alleleDir, gene)}.tfa`
    );

    const alleleLookup = {};
    const lengths = {};
    const inputOutputPairs = _.zip(inputAllelePaths, allelePaths);
    await Promise.map(
      inputOutputPairs,
      async ([inputPath, outputPath]) => {
        const alleleFileDetails = await this._indexAlleleFile(
          inputPath,
          outputPath
        );
        // Each file gives us a map of {allelePrefix: [[alleleName, alleleLength, alleleHash, isReverseCompliment], [...]], ...}
        // This step combines the analysis from each allele file into a single set of data structures.
        _.forEach(alleleFileDetails, (matchingAlleles, allelePrefix) =>
          _.forEach(matchingAlleles, ([allele, length, hash, reverse]) => {
            (alleleLookup[allelePrefix] =
              alleleLookup[allelePrefix] || []).push([
              allele,
              length,
              hash,
              reverse
            ]);
            lengths[allele] = length;
          })
        );
      },
      { concurrency: 3 }
    );
    _.forEach(_.keys(alleleLookup), allelePrefix => {
      alleleLookup[allelePrefix] = _.sortBy(
        alleleLookup[allelePrefix],
        allele => -allele[1]
      );
    });
    return { alleleLookup, lengths, allelePaths };
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

  async _getProfiles(options = {}) {
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
  async indexScheme(
    species,
    scheme,
    genes,
    inputAllelePaths,
    profilesPath,
    retrieved,
    url
  ) {
    logger("debug:metadata:indexScheme")(`Building metadata for ${species}`);

    const schemeDir = path.join(
      this.dataDir,
      slugify(species),
      slugify(scheme)
    );
    await mkdirp(schemeDir, { mode: 0o755 });

    const { alleleLookup, lengths, allelePaths } = await this._indexAlleles(
      inputAllelePaths,
      genes,
      schemeDir
    );
    logger("trace:metadata:indexScheme")(
      `Built hashes and lengths for ${species}`
    );
    const commonGeneLengths = this._getMostCommonGeneLengths(lengths);
    logger("trace:metadata:indexScheme")(
      `Found commonest gene lengths for ${species}`
    );
    const profiles = await this._getProfiles({ profilesPath, genes });

    const metadata = {
      species,
      allelePaths,
      genes,
      lengths,
      alleleLookup,
      alleleLookupPrefixLength: ALLELE_LOOKUP_PREFIX_LENGTH,
      profiles,
      scheme,
      profilesPath,
      commonGeneLengths,
      retrieved,
      url
    };

    const metadataPath = path.join(schemeDir, "metadata.json");
    logger("debug:metadata:write")(
      `Writing metadata for ${species} to ${metadataPath}`
    );
    await writeJson(metadataPath, metadata, { mode: 0o644 });
    logger("debug:metadata:write")(
      `Wrote metadata for ${species} to ${metadataPath}`
    );
    return { metadata, metadataPath };
  }
}

class PubMlstSevenGenomeSchemes extends Metadata {
  constructor(dataDir = MLST_DIR) {
    super();
    this.PUBMLST_URL = "https://pubmlst.org/data/dbases.xml";
    this.rawMetadataPath = urlToPath(this.PUBMLST_URL);
    this.dataDir = dataDir;
    this.metadataPath = path.join(dataDir, "metadata.json");

    this.schemeAliases = {
      1336: 40041 // If we don't find a Streptococcus equi scheme (1336), re-use Streptococcus zooepidemicus (40041)
    };
  }

  async update(speciesTaxIdsMap = {}) {
    const allSpeciesMlstMetadata = {};
    const missingTaxids = [];
    const pubMlstMetadata = await this._parsePubMlstMetadata(
      this.rawMetadataPath
    );
    const latestMetadata = this._latestMetadata(pubMlstMetadata);

    await Promise.map(
      latestMetadata,
      async speciesMetadata => {
        const indexedData = await this._updateSpecies(speciesMetadata);
        const { species } = indexedData;
        let taxids;
        if (species.slice(-5) === " spp.") {
          const genus = species.slice(0, -5);
          taxids = speciesTaxIdsMap[genus];
        } else {
          taxids = speciesTaxIdsMap[species];
        }
        if (taxids && taxids.length > 0) {
          _.forEach(taxids, taxid => {
            indexedData.taxid = taxid; // eslint-disable-line no-param-reassign
            allSpeciesMlstMetadata[taxid] = indexedData;
          });
          return await writeJson(this.metadataPath, allSpeciesMlstMetadata, {
            mode: 0o644
          });
        }
        missingTaxids.push(species);
        return Promise.resolve();
      },
      { concurrency: 3 }
    );

    this._updateMetadataWithAliases(allSpeciesMlstMetadata, this.schemeAliases);
    await writeJson(this.metadataPath, allSpeciesMlstMetadata, { mode: 0o644 });
    logger("debug")(
      `Finished writing metadata for ${_.keys(allSpeciesMlstMetadata)
        .length} species`
    );
    if (missingTaxids) {
      logger("warn:update:missingTaxid")(`Could not find taxids for:`);
      _.forEach(missingTaxids, species =>
        logger("warn:update:missingTaxid")(species)
      );
    }
    return allSpeciesMlstMetadata;
  }

  _updateMetadataWithAliases(speciesMetadata, schemeAliases) {
    _.forEach(schemeAliases, (synonymousSchemeTaxId, schemeTaxId) => {
      const schemeAlreadyExists =
        typeof speciesMetadata[schemeTaxId] !== "undefined";
      const synonymousSchemeAvailable =
        typeof speciesMetadata[synonymousSchemeTaxId] !== "undefined";
      if (synonymousSchemeAvailable && !schemeAlreadyExists) {
        logger("info")(
          `Reusing ${speciesMetadata[synonymousSchemeTaxId]
            .scheme} for ${schemeTaxId}`
        );
        speciesMetadata[schemeTaxId] = speciesMetadata[synonymousSchemeTaxId]; // eslint-disable-line no-param-reassign
      } else if (schemeAlreadyExists) {
        logger("info")(
          `Scheme ${speciesMetadata[schemeTaxId]
            .scheme} already exists for ${schemeTaxId}`
        );
      } else if (!synonymousSchemeAvailable) {
        logger("warning")(
          `Scheme ${synonymousSchemeTaxId} couldn't be copied for ${schemeTaxId}`
        );
      }
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

  async _updateSpecies(speciesData) {
    const { species, scheme, retrieved, url, loci, profilesPath } = speciesData;
    logger("debug:updateSpecies")(`Updating details for ${species}`);
    const inputAllelePaths = _.map(loci, ({ path: p }) => p);
    const genes = _.map(loci, ({ locus }) => locus);
    const { metadataPath } = await this.indexScheme(
      species,
      scheme,
      genes,
      inputAllelePaths,
      profilesPath,
      retrieved,
      url
    );
    return {
      species,
      scheme,
      genes,
      metadataPath,
      retrieved
    };
  }

  async _parsePubMlstMetadata(metadataPath) {
    logger("debug:parsePubMlstMetadata")(`Parsing ${metadataPath}`);
    const metadataFileContents = await promisify(fs.readFile)(metadataPath);
    const metadataXml = await promisify(parseString)(metadataFileContents);
    const species = metadataXml.data.species;
    return _.map(species, this._parsePubMlstSpeciesMetadata);
  }

  _parsePubMlstSpeciesMetadata(data) {
    const species = data._.trim();
    const database = data.mlst[0].database[0];
    const url = database.url[0];
    const retrieved = database.retrieved[0];
    const profiles = database.profiles[0];
    const profilesUrl = profiles.url[0];
    const profilesPath = urlToPath(profilesUrl);

    function parseLocus(locusData) {
      const locus = locusData._.trim();
      const locusUrl = locusData.url[0];
      const locusPath = urlToPath(locusUrl);
      return { locus, path: locusPath };
    }

    const loci = _.map(database.loci[0].locus, parseLocus);
    const scheme = /([^\/]+)\.txt$/.exec(profilesUrl)[1];

    return {
      species,
      scheme,
      retrieved,
      url,
      profilesPath,
      loci
    };
  }
}

class CgMlstMetadata extends Metadata {
  constructor(dataDir = MLST_DIR) {
    super();
    this.metadataPath = path.join(dataDir, "metadataCore.json");
  }

  async update() {
    let schemeDetails;
    try {
      schemeDetails = await readJson(this.schemeDetailsPath);
    } catch (err) {
      const message = `Couldn't load details of Core Genome MLST schemes from ${this
        .schemeDetailsPath}`;
      logger("debug")(message);
      return Promise.reject(message);
    }

    const allSpeciesMlstMetadata = await this.allMetadata();
    await Promise.map(
      schemeDetails,
      async ({ taxid, url, description }) => {
        const scheme = `cgMLST_${taxid}`;
        const schemeMetadataPath = urlToPath(url);
        allSpeciesMlstMetadata[taxid] = await this._updateScheme({
          scheme,
          taxid,
          description,
          schemeMetadataPath,
          url
        });
        await writeJson(this.metadataPath, allSpeciesMlstMetadata, {
          mode: 0o644
        });
      },
      { concurrency: 1 }
    );
    return allSpeciesMlstMetadata;
  }

  async allMetadata() {
    try {
      return await readJson(this.metadataPath);
    } catch (err) {
      return {};
    }
  }

  async _updateScheme() {
    throw Error("Not implemented");
  }

  _getProfiles() {
    return Promise.resolve({});
  }
}

class BigsDbSchemes extends CgMlstMetadata {
  constructor(dataDir, schemeDetailsPath) {
    super(dataDir);
    this.schemeDetailsPath = schemeDetailsPath;
  }

  async _updateScheme(schemeDetails) {
    const { scheme, url, schemeMetadataPath } = schemeDetails;
    logger("debug:updateScheme")(
      `Updating the ${scheme} with data from ${url}`
    );
    const schemeMetadata = await readJson(schemeMetadataPath);
    schemeMetadata.url = url;
    const genes = [];
    const inputAllelePaths = [];
    _.forEach(schemeMetadata.loci, lociUrl => {
      const locus = lociUrl.split("/").pop();
      const locusPath = urlToPath(`${lociUrl}/alleles_fasta`);
      genes.push(locus);
      inputAllelePaths.push(locusPath);
    });
    const profilesPath = null;
    const retrieved = new Date();

    const { metadataPath } = await this.indexScheme(
      scheme,
      scheme,
      genes,
      inputAllelePaths,
      profilesPath,
      retrieved,
      url
    );
    schemeMetadata.metadataPath = metadataPath;
    return schemeMetadata;
  }
}

class RidomSchemes extends CgMlstMetadata {
  constructor(dataDir = MLST_DIR) {
    super(dataDir);
    this.schemeDetailsPath = path.join(
      __dirname,
      "..",
      "schemes",
      "ridom-schemes.json"
    );
    this.metadataPath = path.join(dataDir, "metadataCore.json");
  }

  async _parseZippedXmfa(allelesDownloadPath) {
    logger("trace:RidomSchemes:parsing")(`Parsing ${allelesDownloadPath}`);
    const genes = [];
    const inputAllelePaths = [];
    const alleleFileStream = fs.createReadStream(allelesDownloadPath);

    const tempAlleleDir = await promisify(tmp.dir)({
      mode: "0750",
      prefix: "mlst_ridom_index_",
      unsafeCleanup: true
    });

    const unzippedAlleles = alleleFileStream.pipe(new Unzip());
    const lines = es.split();

    let currentGene;
    let currentAlleleFile;
    const whenAlleleFileClosed = new DeferredPromise();

    lines.on("data", line => {
      if (line.startsWith("#")) {
        currentGene = line.slice(2);
        genes.push(currentGene);
        const allelePath = path.join(tempAlleleDir, `${currentGene}.tfa`);
        logger("trace:RidomSchemes")(`Writing alleles to ${allelePath}`);
        inputAllelePaths.push(allelePath);
        if (typeof currentAlleleFile !== "undefined") {
          currentAlleleFile.end();
        }
        currentAlleleFile = fs.createWriteStream(allelePath);
      } else if (line.startsWith(">")) {
        const allele = line.slice(1);
        currentAlleleFile.write(`>${currentGene}_${allele}\n`);
      } else if (line !== "" || !line.startsWith("=")) {
        currentAlleleFile.write(`${line}\n`);
      }
    });
    lines.on("close", () => whenAlleleFileClosed.resolve());

    unzippedAlleles.pipe(lines);
    await whenAlleleFileClosed;

    logger("trace:RidomSchemes")(
      `Found ${genes.length} genes in ${allelesDownloadPath}`
    );
    return { genes, inputAllelePaths };
  }

  async _updateScheme(schemeDetails) {
    const { scheme, url, schemeMetadataPath } = schemeDetails;
    logger("debug:updateScheme")(
      `Updating the ${scheme} with data from ${url}`
    );
    const { genes, inputAllelePaths } = await this._parseZippedXmfa(
      schemeMetadataPath
    );
    const profilesPath = null;
    const retrieved = new Date();

    const { metadataPath } = await this.indexScheme(
      scheme,
      scheme,
      genes,
      inputAllelePaths,
      profilesPath,
      retrieved,
      url
    );
    schemeDetails.metadataPath = metadataPath; // eslint-disable-line no-param-reassign
    return schemeDetails;
  }
}

class EnterobaseSchemes extends CgMlstMetadata {
  constructor(dataDir = MLST_DIR) {
    super(dataDir);
    this.schemeDetailsPath = path.join(
      __dirname,
      "..",
      "schemes",
      "enterobase-schemes.json"
    );
  }

  async _unzip(inputPath, outputPath) {
    const whenUnzipComplete = new DeferredPromise();
    const unzippedAlleleFile = fs.createWriteStream(outputPath, {
      mode: 0o644
    });
    const zippedAlleleFile = fs.createReadStream(inputPath);
    unzippedAlleleFile.on("close", () => whenUnzipComplete.resolve(outputPath));
    zippedAlleleFile.pipe(new Unzip()).pipe(unzippedAlleleFile);
    return whenUnzipComplete;
  }

  async _updateScheme(schemeDetails) {
    const { scheme, url, schemeMetadataPath } = schemeDetails;
    logger("debug:updateScheme")(
      `Updating the ${scheme} with data from ${url}`
    );

    const tempAlleleDir = await promisify(tmp.dir)({
      mode: "0750",
      prefix: "mlst_enterobase_index_",
      unsafeCleanup: true
    });

    const genes = [];
    const inputAllelePaths = [];
    let nextSchemePath = schemeMetadataPath;
    while (nextSchemePath) {
      const { loci, links } = await readJson(nextSchemePath);
      await Promise.map(
        loci,
        async ({ download_alleles_link, locus }) => {
          if (genes.indexOf(locus) === -1) {
            genes.push(locus);
            const zippedAllelesPath = urlToPath(download_alleles_link);
            const unzippedAllelesPath = path.join(
              tempAlleleDir,
              `${locus}.tfa`
            );
            inputAllelePaths.push(unzippedAllelesPath);
            return await this._unzip(zippedAllelesPath, unzippedAllelesPath);
          }
          return Promise.resolve();
        },
        { concurrency: 3 }
      );
      const nextUrl = _.get(links, "paging.next", null);
      nextSchemePath = nextUrl ? urlToPath(nextUrl) : null;
    }
    const profilesPath = null;
    const retrieved = new Date();

    const { metadataPath } = await this.indexScheme(
      scheme,
      scheme,
      genes,
      inputAllelePaths,
      profilesPath,
      retrieved,
      url
    );
    schemeDetails.metadataPath = metadataPath; // eslint-disable-line no-param-reassign
    return schemeDetails;
  }
}

module.exports = {
  parseAlleleName,
  PubMlstSevenGenomeSchemes,
  CgMlstMetadata,
  BigsDbSchemes,
  RidomSchemes,
  EnterobaseSchemes,
  FastaString
};
