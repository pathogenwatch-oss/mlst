const Promise = require("bluebird");
const fs = require("fs");
const hasha = require("hasha");
const _ = require("lodash");
const mkdirp = require("mkdirp-promise");
const path = require("path")
const slugify = require("slugify");
const { URL } = require("url");
const { promisify } = require("util");

const { loadSpeciesTaxidMap } = require("../src/ncbi-taxid-lookup");
const { reverseCompliment, DeferredPromise } = require("./utils");

const openAsync = promisify(fs.open);
const writeAsync = promisify(fs.write);

async function writeJsonAsync(outputPath, data, options) {
  const jsonData = JSON.stringify(data);
  await promisify(fs.writeFile)(outputPath, jsonData, options);
  logger("debug:writeJson")(`Wrote data to ${outputPath}`);
  return outputPath;
}

async function readJsonAsync(outputPath) {
  const content = await promisify(fs.readFile)(outputPath);
  return JSON.parse(content)
}

function parseAlleleName(allele) {
  try {
    const matches = /^(.+)[-_\.]([0-9]+)$/.exec(allele);
    const [gene, st] = matches.slice(1);
    return { gene, st: Number(st) };
  } catch (err) {
    logger("error")(`Couldn't parse gene and st from ${allele}`);
    throw err;
  }
}

class Scheme {
  constructor(options) {
    this.downloadFn = options.downloadFn;
    this.schemeUrl = options.schemeUrl;
    this.lociCount = options.lociCount;
    this.alleleLookupPrefixLength = 20;
    this.metadata = options.metadata;
  }

  async dowload() {
    throw Error("Not implemented");
  }
  
  async genes() {
    throw Error("Not implemented");
  }

  async alleles(gene) {
    throw Error("Not implemented");
  }

  async profiles() {
    throw Error("Not implemented");
  }

  async index(schemeDir, maxSeq = 0) {
    // maxSeq is the maximum number of sequences for each gene
    await mkdirp(schemeDir, { mode: 0o755 });

    const alleleLookup = {};
    const genes = [];
    const allelePaths = [];
    const lenghts = {}
    _.forEach(this.genes(), gene => {
      genes.push(gene)
      lengths[gene] = {};
      const alleles = this.alleles(gene); // map of allele_id to allele object
      const sortedAlleles = this.sort(alleles);
      if (maxSeq > 0) {
        allelePaths.push(
          await this.write(schemeDir, gene, sortedAlleles.slice(0, maxSeq))
        )
      } else {
        allelePaths.push(
          await this.write(schemeDir, gene, sortedAlleles)
        )
      }
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
          (alleleLookup[prefix] = alleleLookup[prefix] || []).push(details);
        })
        lengths[gene][allele.st] = allele.length
      })
    })

    this.metadata = (this.metadata || {});
    const metadata = {
      ...this.metadata,
      genes,
      allelePaths,
      lengths,
      alleleLookup,
      alleleLookupPrefixLength = this.alleleLookupPrefixLength,
      profiles: this.profiles(),
      url: this.schemeUrl
    };
    const metadataPath = path.join(schemeDir, "metadata.json");
    await writeJsonAsync(metadataPath, metadata);
    return metadataPath;
  }

  sort(alleles) {
    // Sorts the sequences so that you get a good mix of lengths
    // For example, if sequences == {1: [A1, B1, C1], 3: [D3, E3], 4: [F4], 5:[G5, H5, I5, J5]}
    // this returns: [G5, F4, D3, A1, H5, E3, B1, I5, C1, J5]
    return _(alleles)
      .groupBy(allele => allele.length) // {455: [seq, ...], 460: [seq, ...], ...}
      .toPairs() // [[455, [seq, ...]], [460, [seq, ...]], ...]
      .sortBy(([length]) => -length) // [[477, [seq, ...]], [475, [seq, ...]], ...]
      .map(([, seqs]) => seqs) // [[seq1, seq2, ...], [seq11, seq12, ...], ...]
      .thru(seqs => _.zip(...seqs)) // [[seq1, seq11, ...], [seq2, undefined, ...], ...]
      .flatten() // [seq1, seq11, ..., seq2, undefined, ...]
      .filter(el => typeof el !== "undefined") // [seq1, seq11, ..., seq2, ...]
      .value();
  }

  hash(allele) {
    const { st, length, seq } = allele;
    const hash = hasha(sequence, { algorithm: "sha1" });
    const prefix = sequence.slice(0, this.alleleLookupPrefixLength);

    const complimentarySequence = reverseCompliment(sequence);
    const rcHash = hasha(complimentarySequence, { algorithm: "sha1" });
    const rcPrefix = complimentarySequence.slice(
      0,
      ALLELE_LOOKUP_PREFIX_LENGTH
    );

    return [
      [prefix, gene, st, length, hash, false],
      [rcPrefix, gene, st, length, rcHash, true]
    ]
  }

  async write(schemeDir, gene, alleles) {
    const alleleFile = path.join(schemeDir, `${gene}.fasta`);
    fd = await openAsync(alleleFile, 'w');
    _.forEach(alleles, allele => {
      const alleleString = `>${allele.gene}_${allele.st}\n${allele.seq}\n`;
      await writeAsync(fd, alleleString)
    });
    return path.resolve(alleleFile)
  }

  _readFasta(fastaPath) {
    seqs = []
    const whenDone = new DeferredPromise();
    fasta
      .obj(inputPath)
      .on("data", seq => {
        const { id, seq: sequence } = seq;
        seqs.push({
          id,
          seq: sequence.toLowerCase(),
          length: sequence.length
        })
      })
      .on("end", () => {
        whenDone.resolve(seqs);
      })
      .on("error", err => {
        whenDone.reject(err);
      })
    return whenDone
  }
}

class PubMlstSevenGeneScheme extends Scheme {
  constructor(options) {
    this.downloadFn = options.downloadFn;
    this.alleleLookupPrefixLength = 20;
    this.profilesUrl = options.profilesUrl;
    this.lociUrls = options.lociUrls;
    this.metadata = options.metadata;
  }

  async download() {
    const profilesPath = await this.downloadFn(this.profilesUrl)
    const allelesPaths = await Promise.map(
      this.lociUrls, url => this.downloadFn(url),
      { concurrency: 1 }
    )
    return { profilesPath, allelesPaths };
  }

  async genes() {
    return _(this.lociUrls)
      .keys()
      .sort()
      .value();
  }

  async alleles(gene) {
    const allelesUrl = this.lociUrls[gene];
    const allelesPath = this.downloadFn(allelesUrl);
    const rawSeqs = await this._readFasta(allelesPath);
    return _.map(rawSeqs, s => {
      const { id, seq, length } = s;
      const { st } = parseAlleleName(id);
      return { gene, st, length, seq };
    })
  }

  async _rowParserFactory(header) {
    // Returns a function which maps a row to an object
    const genes = this.genes();
    return row => {
      const rowObj = _(header).zip(row).fromPairs().value();
      const alleles = _.map(genes, gene => rowObj[gene]);
      const st = rowObj.ST;
      return { st, alleles };
    };
  }

  async profiles() {
    const profilesPath = this.downloadFn(this.profilesUrl);
    const rowParser = null;
    const output = new DeferredPromise();
    const profiles = {}

    readline.createInterface({
      input: fs.createReadStream(profilesPath)
    })
      .on("line", line => {
        const row = line.split("\t");
        if (rowParser === null) {
          // This is the header row
          rowParser = this._rowParserFactory(row);
        } else {
          const { st, alleles } = rowParser(row);
          const allelesKey = alleles.join("_");
          profileData[allelesKey] = st;
        }
      })
      .on("close", () => {
        output.resolve(profiles);
      })
      .on("error", err => {
        output.reject(err);
      })
    return profiles
  }
}

class PubMlstSevenGeneSchemes {
  constructor(options) {
    this.downloadFn = options.downloadFn;
    this.ftpDownloadFn = options.ftpDownloadFn;
    this.schemesUrl = "https://pubmlst.org/data/dbases.xml";
    this.taxdumpUrl = "ftp://ftp.ncbi.nih.gov/pub/taxonomy/taxdump.tar.gz"
    this.schemeAliases = {
      1336: 40041 // If we don't find a Streptococcus equi scheme (1336), re-use Streptococcus zooepidemicus (40041)
    };
    this.dataDir = "/opt/mlst/databases"
  }

  async read(taxid) {
    const metadata = await this.loadMetadata();
    const schemeMetadataPath = metadata[taxid];
    if (!schemeMetadataPath)
      return undefined
    try {
      return await readJsonAsync(schemeMetadataPath)  
    } catch (err) {
      return undefined
    }
  }

  loadMetadata() {
    const metadataPath = path.join(this.dataDir, "seven_gene_metadata.json");
    try {
      return readJsonAsync(metadataPath);
    } catch (err) {
      return {}
    }
  }

  writeMetadata(metadata) {
    const metadataPath = path.join(this.dataDir, "seven_gene_metadata.json");
    return writeJsonAsync(metadataPath, metadata)
  }

  async download() {
    const taxDumpPath = await this.ftpDownloadFn(this.taxdumpUrl);
    const schemes = await this.getSchemes();
    return Promise.map(
      schemes, scheme => scheme.download(),
      { concurrency: 3 }
    );
  }

  async index() {
    const schemes = this.getSchemes();
    const taxDumpPath = await this.ftpDownloadFn(this.taxdumpUrl);
    const speciesTaxIdsMap = await loadSpeciesTaxidMap(taxDumpPath);
    const metadata = await this.loadMetadata();

    await Promise.map(schemes, scheme => {
      const { species, schemeName, url } = scheme.metadata;
      const schemeSlug = `mlst_${slugify(species)}`;
      const schemeDir = path.join(this.dataDir, schemeSlug);
      const schemeMetadataPath = await scheme.index(schemeDir);

      let taxids;
      if (species.slice(-5) === " spp.") {
        const genus = species.slice(0, -5);
        taxids = speciesTaxIdsMap[genus] || [];
      } else {
        taxids = speciesTaxIdsMap[species] || [];
      }

      _.forEach(taxids, taxid => {
        metadata[taxid] = {
          path: schemeMetadataPath,
          species,
          schemeName,
          url
        }
      }),

      await this.writeMetadata(metadata)
    }, { concurrency: 3 });

    _.forEach(this.schemeAliases, (scheme, alias) => {
      // If we have `scheme` but `alias` is missing, use `scheme` for `alias`
      if (!metadata[alias] && !!metadata[scheme]) {
        metadata[alias] = metadata[scheme];
      }
    })

    await this.writeMetadata(metadata);
  }

  async _parseMetadata(content) {
    const rawMetadata = await parseXmlAsync(content);
    const rawSchemeData = rawMetadata.data.species;
    return _.map(rawSchemeData, data => {
      const database = data.mlst[0].database[0];
      const url = database.url[0];
      const profiles = database.profiles[0];
      const profilesUrl = profiles.url[0];
      const lociUrls = _(database.loci[0].locus)
        .map(l => [l._.trim(), l.url[0]])
        .fromPairs()
        .value()
      const schemeName = data.species;

      const nameParts = schemeName.split("#");
      const species = nameParts[0];
      const version = Number(nameParts[1] || 0);
      return {
        profilesUrl,
        lociUrls,
        species,
        version,
        schemeName,
        url
      }
    })
  }

  _pickLatest(schemeData) {
    return _(schemeData)
      .groupBy('species')
      .values()
      .map(versions => _.sortBy(versions, 'version')[-1])
      .value()
  }

  async getSchemes() {
    const metadataPath = await this.downloadFn(this.schemesUrl);
    const metadataContent = await readFileAsync(metadataPath);
    const allSchemeData = await this._parseMetadata(metadataContent);
    const latestSchemeData = this._pickLatest(allSchemeData);

    return _.map(latestSchemeData, ({ profilesUrl, lociUrls, ...metadata }) => 
      new PubMlstSevenGeneScheme({
        downloadFn: this.downloadFn,
        profilesUrl,
        lociUrls,
        metadata
      })
    )
  }
}

class BigsDbHtmlScheme extends Scheme {
  async parseBigsDbHtml(downloadUrl, downloadPath) {
    const content = await readFileAsync(downloadPath);
    const $ = cheerio.load(content.toString());
    const { origin: urlRoot } = new URL(downloadUrl);
  
    function parseRow(row) {
      const columns = $(row).find("td");
      if (columns.length < 2) {
        return null;
      }
      const urlPath = $(columns[1]).find("a").attr("href");
      if (!urlPath) return null;
      const locus = $(columns[0]).text();
      return { locus, url: `${urlRoot}${urlPath}` };
    }
  
    const rows = $("table.resultstable").find("tr");
    const lociUrls = {};
    rows.each((i, row) => {
      const locus = parseRow(row);
      if (locus) {
        lociUrls[locus.locus] = locus.url;
      }
    });
  
    return lociUrls;
  }

  async lociUrls() {
    if (!this._lociUrls) {
      const schemePath = await this.downloadFn(this.schemeUrl);
      this._lociUrls = await parseBigsDbHtml(this.schemeUrl, schemePath);
    }
    return this._lociUrls;
  }

  async dowload() {
    const alleleUrls = await this.lociUrls();
    if (alleleUrls.length !== this.lociCount) {
      throw new Error(
        `Expected ${this.lociCount} for ${this.metadata.schemeName}, got ${alleleUrls.length}`
      );
    }
    const lociPaths = await Promise.map(alleleUrls, lociUrl =>
      this.downloadFn(lociUrl)
    );
    return [schemePath, ...lociPaths];
  }
  
  async genes() {
    const alleleUrls = await this.lociUrls();
    return _(alleleUrls).keys().sort().value()
  }

  async alleles(gene) {
    const alleleUrls = await this.lociUrls();
    const alleleUrl = alleleUrls[gene];
    if (!alleleUrl)
      throw new Error(`Problem finding ${gene} in ${this.metadata.schemeName}`)
    const allelePaths = await this.downloadFn(alleleUrl);
    const rawSeqs = await this._readFasta(allelesPath);
    return _.map(rawSeqs, s => {
      const { id, seq, length } = s;
      const { st } = parseAlleleName(id);
      return { gene, st, length, seq };
    })
  }

  profiles() {
    return {}
  }
}

class BigsDbRestScheme extends Scheme {
  async lociUrls() {
    if (!this._lociUrls) {
      const schemePath = await this.downloadFn(this.schemeUrl);
      const schemeDetails = await readJsonAsync(schemePath);
      this._lociUrls = _(schemeDetails.loci)
        .map(url => {
          const locus = url.split("/")[-1];
          const downloadUrl = `${url}/alleles_fasta`;
          return [locus, downloadUrl]
        })
        .fromPairs()
        .value()
    }
    return this._lociUrls;
  }

  async dowload() {
    const alleleUrls = await this.lociUrls();
    const allelePaths = await Promise.map(alleleUrls, url => this.downloadFn(url))
    if (allelePaths.length !== this.lociCount) {
      throw new Error(
        `Expected ${this.lociCount} for ${this.metadata.schemeName}, got ${allelePaths.length}`
      );
    }
    return [schemePath, ...allelePaths];
  }
  
  async genes() {
    const alleleUrls = await this.lociUrls();
    return _(alleleUrls).keys().sort().value()
  }

  async alleles(gene) {
    const schemePath = await this.downloadFn(this.schemeUrl);
    const schemeDetails = await readJsonAsync(schemePath);
    const matchingLoci = _.filter(schemeDetails.loci, url => url.split("/")[-1] === gene);
    if (matchingLoci != 1)
      throw new Error(`Problem finding ${gene} in ${this.metadata.schemeName}`)
    const allelePath = await this.downloadFn(matchingLoci[0])
    const rawSeqs = await this._readFasta(allelesPath);
    return _.map(rawSeqs, s => {
      const { id, seq, length } = s;
      const { st } = parseAlleleName(id);
      return { gene, st, length, seq };
    })
  }

  profiles() {
    return {}
  }
}

class RidomScheme extends Scheme {
  async _parseAlleleZip(allelesDownloadPath) {
    logger("trace:RidomSchemes:parsing")(`Parsing ${allelesDownloadPath}`);
    const genes = [];
    const inputAllelePaths = [];
    const alleleZip = new AdmZip(allelesDownloadPath);

    const tempAlleleDir = await promisify(tmp.dir)({
      mode: "0750",
      prefix: "mlst_ridom_index_",
      unsafeCleanup: true
    });

    _.forEach(alleleZip.getEntries(), ({ entryName }) => {
      const filename = path.basename(entryName);
      const gene = filename.replace(/\.(fa|fasta|mfa|tfa)$/, "");
      alleleZip.extractEntryTo(entryName, tempAlleleDir, false)
      genes.push(gene);
      inputAllelePaths.push(path.join(tempAlleleDir, filename))
    })

    logger("trace:RidomSchemes")(
      `Found ${genes.length} genes in ${allelesDownloadPath}`
    );
    return { genes, inputAllelePaths };
  }

  async dowload() {
    const allelesDownloadPath = await this.downloadFn(this.schemeUrl);
    return allelesDownloadPath
  }
  
  async genes() {
    const allelesDownloadPath = await this.downloadFn(this.schemeUrl);
    return allelesDownloadPath
  }

  async alleles(gene) {
    throw Error("Not implemented");
  }

  async profiles() {
    throw Error("Not implemented");
  }
}