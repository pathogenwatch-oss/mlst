const AdmZip = require("adm-zip");
const Promise = require("bluebird");
const cheerio = require("cheerio");
const logger = require("debug");
const fasta = require("bionode-fasta");
const fs = require("fs");
const hasha = require("hasha");
const _ = require("lodash");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const readline = require("readline");
const slugify = require("slugify");
const { URL } = require("url");
const { promisify } = require("util");
const { parseString: parseXml } = require("xml2js");
const { Unzip } = require("zlib");

const { loadSpeciesTaxidMap } = require("../src/ncbi-taxid-lookup");
const { reverseCompliment, DeferredPromise } = require("./utils");

const openAsync = promisify(fs.open);
const readFileAsync = promisify(fs.readFile);
const writeAsync = promisify(fs.write);
const parseXmlAsync = promisify(parseXml);

async function writeJsonAsync(outputPath, data, options) {
  const jsonData = JSON.stringify(data);
  await promisify(fs.writeFile)(outputPath, jsonData, options);
  logger("debug:writeJson")(`Wrote data to ${outputPath}`);
  return outputPath;
}

async function readJsonAsync(outputPath) {
  const content = await promisify(fs.readFile)(outputPath);
  return JSON.parse(content);
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

  async lociUrls() {
    throw Error("Not implemented");
  }

  async dowload() {
    const alleleUrls = await this.lociUrls();
    if (this.lociCount && alleleUrls.length !== this.lociCount) {
      throw new Error(
        `Expected ${this.lociCount} for ${this.metadata.schemeName}, got ${
          alleleUrls.length
        }`
      );
    }
    return Promise.map(alleleUrls, lociUrl => this.downloadFn(lociUrl));
  }

  async genes() {
    const alleleUrls = await this.lociUrls();
    return _(alleleUrls)
      .keys()
      .sort()
      .value();
  }

  async alleles(gene) {
    const alleleUrls = await this.lociUrls();
    const alleleUrl = alleleUrls[gene];
    if (!alleleUrl)
      throw new Error(`Problem finding ${gene} in ${this.metadata.schemeName}`);
    const allelesPath = await this.downloadFn(alleleUrl);
    const rawSeqs = await this._readFasta(allelesPath);
    return _.map(rawSeqs, s => {
      const { id, seq, length } = s;
      const { st } = parseAlleleName(id);
      return { gene, st, length, seq };
    });
  }

  profiles() {
    return {};
  }

  async index(schemeDir, maxSeqs = 0) {
    // maxSeqs is the maximum number of sequences for each gene
    await mkdirp(schemeDir, { mode: 0o755 });

    const alleleLookup = {};
    const genes = [];
    const allelePaths = [];
    const lengths = {};
    await Promise.map(
      this.genes(),
      async gene => {
        genes.push(gene);
        lengths[gene] = {};
        const alleles = this.alleles(gene); // map of allele_id to allele object
        const sortedAlleles = this.sort(alleles);
        if (maxSeqs > 0) {
          allelePaths.push(
            await this.write(schemeDir, gene, sortedAlleles.slice(0, maxSeqs))
          );
        } else {
          allelePaths.push(await this.write(schemeDir, gene, sortedAlleles));
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
            (alleleLookup[prefix] = alleleLookup[prefix] || []).push([
              gene,
              ...details
            ]);
          });
          lengths[gene][allele.st] = allele.length;
        });
      },
      { concurrency: 3 }
    );

    this.metadata = this.metadata || {};
    const metadata = {
      ...this.metadata,
      genes,
      allelePaths,
      lengths,
      alleleLookup,
      alleleLookupPrefixLength: this.alleleLookupPrefixLength,
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

  async write(schemeDir, gene, alleles) {
    const alleleFile = path.join(schemeDir, `${gene}.fasta`);
    const fd = await openAsync(alleleFile, "w");
    await Promise.map(
      alleles,
      async allele => {
        const alleleString = `>${allele.gene}_${allele.st}\n${allele.seq}\n`;
        await writeAsync(fd, alleleString);
      },
      { concurrency: 1 }
    );
    return path.resolve(alleleFile);
  }

  _readFasta(fastaPath) {
    const seqs = [];
    const whenDone = new DeferredPromise();
    fasta
      .obj(fastaPath)
      .on("data", seq => {
        const { id, seq: sequence } = seq;
        seqs.push({
          id,
          seq: sequence.toLowerCase(),
          length: sequence.length
        });
      })
      .on("end", () => {
        whenDone.resolve(seqs);
      })
      .on("error", err => {
        whenDone.reject(err);
      });
    return whenDone;
  }
}

class PubMlstSevenGeneScheme extends Scheme {
  constructor(options) {
    this.downloadFn = options.downloadFn;
    this.alleleLookupPrefixLength = 20;
    this.profilesUrl = options.profilesUrl;
    this._lociUrls = options.lociUrls;
    this.metadata = options.metadata;
  }

  lociUrls() {
    return this._lociUrls;
  }

  async download() {
    const profilesPath = await this.downloadFn(this.profilesUrl);
    const allelesPaths = await Promise.map(
      this.lociUrls,
      url => this.downloadFn(url),
      { concurrency: 1 }
    );
    return { profilesPath, allelesPaths };
  }

  async _rowParserFactory(header) {
    // Returns a function which maps a row to an object
    const genes = this.genes();
    return row => {
      const rowObj = _(header)
        .zip(row)
        .fromPairs()
        .value();
      const alleles = _.map(genes, gene => rowObj[gene]);
      const st = rowObj.ST;
      return { st, alleles };
    };
  }

  async profiles() {
    const profilesPath = this.downloadFn(this.profilesUrl);
    let rowParser;
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
          rowParser = this._rowParserFactory(row);
        } else {
          const { st, alleles } = rowParser(row);
          const allelesKey = alleles.join("_");
          profiles[allelesKey] = st;
        }
      })
      .on("close", () => {
        output.resolve(profiles);
      })
      .on("error", err => {
        output.reject(err);
      });
    return profiles;
  }
}

class PubMlstSevenGeneSchemes {
  constructor(options) {
    this.downloadFn = options.downloadFn;
    this.ftpDownloadFn = options.ftpDownloadFn;
    this.schemesUrl = "https://pubmlst.org/data/dbases.xml";
    this.taxdumpUrl = "ftp://ftp.ncbi.nih.gov/pub/taxonomy/taxdump.tar.gz";
    this.schemeAliases = {
      1336: 40041 // If we don't find a Streptococcus equi scheme (1336), re-use Streptococcus zooepidemicus (40041)
    };
    this.dataDir = options.dataDit || "/opt/mlst/databases";
  }

  async read(taxid) {
    const metadata = await this.loadMetadata();
    const schemeMetadataPath = metadata[taxid];
    if (!schemeMetadataPath) return undefined;
    try {
      return await readJsonAsync(schemeMetadataPath);
    } catch (err) {
      return undefined;
    }
  }

  loadMetadata() {
    const metadataPath = path.join(this.dataDir, "seven_gene_metadata.json");
    try {
      return readJsonAsync(metadataPath);
    } catch (err) {
      return {};
    }
  }

  writeMetadata(metadata) {
    const metadataPath = path.join(this.dataDir, "seven_gene_metadata.json");
    return writeJsonAsync(metadataPath, metadata);
  }

  async download() {
    await this.ftpDownloadFn(this.taxdumpUrl);
    const schemes = await this.getSchemes();
    return Promise.map(schemes, scheme => scheme.download(), {
      concurrency: 3
    });
  }

  async index() {
    const schemes = this.getSchemes();
    const taxDumpPath = await this.ftpDownloadFn(this.taxdumpUrl);
    const speciesTaxIdsMap = await loadSpeciesTaxidMap(taxDumpPath);
    const metadata = await this.loadMetadata();

    await Promise.map(
      schemes,
      async scheme => {
        const { species, schemeName, url } = scheme.metadata;
        const schemeSlug = `mlst_${slugify(schemeName)}`;
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
          };
        });
        await this.writeMetadata(metadata);
      },
      { concurrency: 3 }
    );

    _.forEach(this.schemeAliases, (scheme, alias) => {
      // If we have `scheme` but `alias` is missing, use `scheme` for `alias`
      if (!metadata[alias] && !!metadata[scheme]) {
        metadata[alias] = metadata[scheme];
      }
    });

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
        .value();
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
      };
    });
  }

  _pickLatest(schemeData) {
    return _(schemeData)
      .groupBy("species")
      .values()
      .map(versions => _.sortBy(versions, "version")[-1])
      .value();
  }

  async getSchemes() {
    const metadataPath = await this.downloadFn(this.schemesUrl);
    const metadataContent = await readFileAsync(metadataPath);
    const allSchemeData = await this._parseMetadata(metadataContent);
    const latestSchemeData = this._pickLatest(allSchemeData);

    return _.map(
      latestSchemeData,
      ({ profilesUrl, lociUrls, ...metadata }) =>
        new PubMlstSevenGeneScheme({
          downloadFn: this.downloadFn,
          profilesUrl,
          lociUrls,
          metadata
        })
    );
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
      const urlPath = $(columns[1])
        .find("a")
        .attr("href");
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
      this._lociUrls = await this.parseBigsDbHtml(this.schemeUrl, schemePath);
    }
    return this._lociUrls;
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
          return [locus, downloadUrl];
        })
        .fromPairs()
        .value();
    }
    return this._lociUrls;
  }

  profiles() {
    return {};
  }
}

class RidomScheme extends Scheme {
  async _extractAlleleZip(allelesDownloadPath) {
    logger("trace:RidomSchemes:parsing")(`Parsing ${allelesDownloadPath}`);
    const allAllelePaths = {};
    const alleleZip = new AdmZip(allelesDownloadPath);
    const alleleDir = path.dirname(allelesDownloadPath);
    await mkdirp(alleleDir, { mode: 0o755 });

    _.forEach(alleleZip.getEntries(), ({ entryName }) => {
      const filename = path.basename(entryName);
      const gene = filename.replace(/\.(fa|fasta|mfa|tfa)$/, "");
      alleleZip.extractEntryTo(entryName, alleleDir, false);
      const allelePath = path.join(alleleDir, filename);
      allAllelePaths[gene] = allelePath;
    });

    logger("trace:RidomSchemes")(
      `Found ${allAllelePaths.length} genes in ${allelesDownloadPath}`
    );
    return allAllelePaths;
  }

  async dowload() {
    return this.downloadFn(this.schemeUrl);
  }

  async allAllelePaths() {
    if (!this._allAllelePaths) {
      const allelesDownloadPath = await this.download();
      this._allAllelePaths = this._extractAlleleZip(allelesDownloadPath);
    }
    return this._allAllelePaths;
  }

  async genes() {
    const allAllelePaths = await this.allAllelePaths();
    return _(allAllelePaths)
      .keys()
      .sort()
      .value();
  }

  async alleles(gene) {
    const allAllelePaths = await this.allAllelePaths();
    const allelesPath = allAllelePaths[gene];
    if (!allelesPath)
      throw new Error(`Problem finding ${gene} in ${this.metadata.schemeName}`);
    const rawSeqs = await this._readFasta(allelesPath);
    return _.map(rawSeqs, s => {
      const { id, seq, length } = s;
      const st = Number(id);
      return { gene, st, length, seq };
    });
  }
}

class EnterobaseScheme extends Scheme {
  constructor(options) {
    super(options);
    this.downloadFn = (url, downloadOpts) => {
      const API_KEY = process.env.ENTEROBASE_API_KEY;
      if (typeof API_KEY === "undefined") {
        throw new Error(
          "Please set the ENTEROBASE_API_KEY environment variable"
        );
      }
      const authOptions = {
        auth: { username: API_KEY, password: "" }
      };
      return downloadOpts.downloadFn(url, { ...downloadOpts, ...authOptions });
    };
  }

  async lociUrls() {
    if (!this._lociUrls) {
      let nextPath = await this.downloadFn(this.schemeUrl);
      const lociUrls = {};
      while (nextPath) {
        const { loci, links } = await readJsonAsync(nextPath);
        _.forEach(loci, ({ download_alleles_link: url, locus: gene }) => {
          lociUrls[gene] = url;
        });
        const nextUrl = _.get(links, "paging.next", null);
        nextPath = nextUrl ? await this.downloadFn(nextUrl) : null;
      }
      this._lociUrls = lociUrls;
    }
    return this._lociUrls;
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

  async alleles(gene) {
    const alleleUrls = await this.lociUrls();
    const alleleUrl = alleleUrls[gene];
    if (!alleleUrl)
      throw new Error(`Problem finding ${gene} in ${this.metadata.schemeName}`);
    const zippedAllelesPath = await this.downloadFn(alleleUrl);
    const unzippedAllelesPath = path.join(
      path.dirname(zippedAllelesPath),
      `${gene}.raw.fa`
    );
    await this._unzip(zippedAllelesPath, unzippedAllelesPath);

    const rawSeqs = await this._readFasta(unzippedAllelesPath);
    return _.map(rawSeqs, s => {
      const { id, seq, length } = s;
      const { st } = parseAlleleName(id);
      return { gene, st, length, seq };
    });
  }
}

class CgMlstSchemes {
  constructor(options) {
    this.downloadFn = options.downloadFn;
    this.maxSeqs = options.maxSeqs;
    this.dataDir = options.dataDit || "/opt/mlst/databases";
    this.schemes = [
      {
        scheme: new EnterobaseScheme({
          schemeUrl:
            "http://enterobase.warwick.ac.uk/api/v2.0/senterica/cgMLST_v2/loci?scheme=cgMLST_v2&limit=50",
          metadata: {
            schemeName: "Salmonella enterica cgMLST V2",
            cite: [
              {
                text: "Alikhan et al. (2018) PLoS Genet 14 (4): e1007261",
                url: "https://doi.org/10.1371/journal.pgen.1007261"
              }
            ]
          }
        }),
        schemeTargets: [{ name: "Salmonella enterica", taxid: 28901 }]
      },
      {
        scheme: new EnterobaseScheme({
          schemeUrl:
            "http://enterobase.warwick.ac.uk/api/v2.0/ecoli/cgMLST/loci?scheme=cgMLST&limit=50",
          metadata: {
            schemeName: "Escherichia/Shigella cgMLSTv1",
            cite: [
              {
                text: "Alikhan et al. (2018) PLoS Genet 14 (4): e1007261",
                url: "https://doi.org/10.1371/journal.pgen.1007261"
              }
            ]
          }
        }),
        schemeTargets: [
          { name: "Escherichia", taxid: 561 },
          { name: "Shigella", taxid: 620 }
        ]
      },
      {
        scheme: new BigsDbHtmlScheme({
          schemeUrl:
            "http://bigsdb.pasteur.fr/perl/bigsdb/bigsdb.pl?db=pubmlst_klebsiella_seqdef_public&page=downloadAlleles&scheme_id=3",
          lociCount: 632,
          metadata: {
            schemeName:
              "Klebsiella pneumoniae/quasipneumoniae/variicola scgMLST634",
            cite: []
          }
        }),
        schemeTargets: [
          { name: "Klebsiella pneumoniae", taxid: 573 },
          { name: "Klebsiella quasipneumoniae", taxid: 1463165 },
          { name: "Klebsiella variicola", taxid: 244366 }
        ]
      },
      {
        scheme: new BigsDbHtmlScheme({
          schemeUrl:
            "http://bigsdb.pasteur.fr/perl/bigsdb/bigsdb.pl?db=pubmlst_listeria_seqdef_public&page=downloadAlleles&scheme_id=3",
          lociCount: 1748,
          metadata: {
            schemeName: "Listeria cgMLST1748",
            cite: []
          }
        }),
        schemeTargets: [{ name: "Listeria", taxid: 1637 }]
      },
      {
        scheme: new BigsDbRestScheme({
          schemeUrl:
            "http://rest.pubmlst.org/db/pubmlst_campylobacter_seqdef/schemes/4",
          metadata: {
            schemeName: "C. jejuni / C. coli cgMLST v1.0",
            cite: [
              {
                text: "Jolley & Maiden 2010, BMC Bioinformatics, 11:595",
                url: "http://www.biomedcentral.com/1471-2105/11/595/abstract",
                long:
                  "This tool made use of the Campylobacter Multi Locus Sequence Typing website (https://pubmlst.org/campylobacter/) sited at the University of Oxford"
              }
            ]
          }
        }),
        schemeTargets: [
          { name: "Campylobacter jejuni", taxid: 197 },
          { name: "Campylobacter coli", taxid: 195 }
        ]
      },
      {
        scheme: new BigsDbRestScheme({
          schemeUrl:
            "http://rest.pubmlst.org/db/pubmlst_neisseria_seqdef/schemes/47",
          metadata: {
            schemeName: "N. meningitidis cgMLST v1.0",
            cite: [
              {
                text: "Jolley & Maiden 2010, BMC Bioinformatics, 11:595",
                url: "http://www.biomedcentral.com/1471-2105/11/595/abstract",
                long:
                  "This tool made use of the Neisseria Multi Locus Sequence Typing website (https://pubmlst.org/neisseria/) developed by Keith Jolley and sited at the University of Oxford"
              }
            ]
          }
        }),
        schemeTargets: [{ name: "Neisseria meningitidis", taxid: 487 }]
      },
      {
        scheme: new BigsDbRestScheme({
          schemeUrl:
            "http://rest.pubmlst.org/db/pubmlst_neisseria_seqdef/schemes/62",
          metadata: {
            schemeName: "N. gonorrhoeae cgMLST v1.0",
            cite: [
              {
                text: "Jolley & Maiden 2010, BMC Bioinformatics, 11:595",
                url: "http://www.biomedcentral.com/1471-2105/11/595/abstract",
                long:
                  "This tool made use of the Neisseria Multi Locus Sequence Typing website (https://pubmlst.org/neisseria/) developed by Keith Jolley and sited at the University of Oxford"
              }
            ]
          }
        }),
        schemeTargets: [{ name: "Neisseria gonorrhoeae", taxid: 485 }]
      },
      {
        scheme: new BigsDbRestScheme({
          schemeUrl:
            "http://rest.pubmlst.org/db/pubmlst_saureus_seqdef/schemes/2",
          metadata: {
            schemeName: "S. aureus Core 2208",
            cite: [
              {
                text: "Jolley & Maiden 2010, BMC Bioinformatics, 11:595",
                url: "http://www.biomedcentral.com/1471-2105/11/595/abstract",
                long:
                  "This tool made use of the Staphylococcus aureus MLST website (https://pubmlst.org/saureus/) sited at the University of Oxford"
              }
            ]
          }
        }),
        schemeTargets: [{ name: "Staphylococcus aureus", taxid: 1280 }]
      },
      {
        scheme: new RidomScheme({
          schemeUrl: "http://www.cgmlst.org/ncs/schema/3956907/alleles/",
          lociCount: 2390,
          metadata: {
            schemeName: "Acinetobacter baumannii",
            cite: [
              {
                text: "Higgins PG et al. (2017) PLoS ONE. 12",
                url: "https://www.ncbi.nlm.nih.gov/pubmed/28594944",
                long:
                  "Higgins PG, Prior K, Harmsen D, and Seifert H. Development and evaluation of a core genome multilocus typing scheme for whole-genome sequence-based typing of Acinetobacter baumannii. PLoS ONE. 2017, 12: e0179228: e0179228"
              }
            ]
          }
        }),
        schemeTargets: [{ name: "Acinetobacter baumannii", taxid: 470 }]
      },
      {
        scheme: new RidomScheme({
          schemeUrl: "http://www.cgmlst.org/ncs/schema/991893/alleles/",
          lociCount: 1423,
          metadata: {
            schemeName: "Enterococcus faecium",
            cite: [
              {
                text: "de Been M et al. (2015) J. Clin. Microbiol. 53",
                url: "https://www.ncbi.nlm.nih.gov/pubmed/26400782",
                long:
                  "de Been M, Pinholt M, Top J, Bletz S, Mellmann A, van Schaik W, Brouwer E, Rogers M, Kraat Y, Bonten M, Corander J, Westh H, Harmsen D, and Willems RJ. Core Genome Multilocus Sequence Typing Scheme for High- Resolution Typing of Enterococcus faecium. J. Clin. Microbiol. 2015, 53: 3788-97: 3788-97"
              }
            ]
          }
        }),
        schemeTargets: [{ name: "Enterococcus faecium", taxid: 1352 }]
      },
      {
        scheme: new RidomScheme({
          schemeUrl: "http://www.cgmlst.org/ncs/schema/741110/alleles/",
          lociCount: 2891,
          metadata: {
            schemeName: "Mycobacterium tuberculosis/bovis/africanum/canettii",
            cite: [
              {
                text: "Kohl TA et al. (2014) J. Clin. Microbiol. 52",
                url: "https://www.ncbi.nlm.nih.gov/pubmed/24789177",
                long:
                  "Kohl TA, Diel R, Harmsen D, Rothgänger J, Walter KM, Merker M, Weniger T, and Niemann S. Whole-genome-based Mycobacterium tuberculosis surveillance: a standardized, portable, and expandable approach. J. Clin. Microbiol. 2014, 52: 2479-86: 2479-86"
              }
            ]
          }
        }),
        schemeTargets: [
          { name: "Mycobacterium tuberculosis", taxid: 1773 },
          { name: "Mycobacterium bovis", taxid: 1765 },
          { name: "Mycobacterium africanum", taxid: 33894 },
          { name: "Mycobacterium canettii", taxid: 78331 }
        ]
      }
    ];
  }

  async read(taxid) {
    const metadata = await this.loadMetadata();
    const schemeMetadataPath = metadata[taxid];
    if (!schemeMetadataPath) return undefined;
    try {
      return await readJsonAsync(schemeMetadataPath);
    } catch (err) {
      return undefined;
    }
  }

  loadMetadata() {
    const metadataPath = path.join(this.dataDir, "cgmlst_metadata.json");
    try {
      return readJsonAsync(metadataPath);
    } catch (err) {
      return {};
    }
  }

  writeMetadata(metadata) {
    const metadataPath = path.join(this.dataDir, "cgmlst_metadata.json");
    return writeJsonAsync(metadataPath, metadata);
  }

  download() {
    return Promise.map(this.schemes, scheme => scheme.download());
  }

  index() {
    const metadata = this.loadMetadata();

    return Promise.map(
      this.schemes,
      async ({ scheme, schemeTargets }) => {
        const { schemeName } = scheme.metadata;
        const schemeSlug = `cgmlst_${slugify(schemeName)}`;
        const schemeDir = path.join(this.dataDir, schemeSlug);
        const schemeMetadataPath = await scheme.index(schemeDir, this.maxSeqs);
        _.forEach(schemeTargets, ({ name, taxid }) => {
          metadata[taxid] = {
            path: schemeMetadataPath,
            species: name,
            schemeName,
            url: scheme.schemeUrl,
            maxSeqs: this.maxSeqs
          };
        });
        await this.writeMetadata(metadata);
      },
      { concurrency: 1 }
    );
  }
}

module.exports = { PubMlstSevenGeneSchemes, CgMlstSchemes };

if (require.main === module) {
  const { shouldRunCgMlst } = require("./parseEnvVariables");
  const { downloadFile, getFromCache, ftpDownloadFile } = require("./download");
  const { fail } = require("./utils");

  process.on("unhandledRejection", reason =>
    fail("unhandledRejection")(reason)
  );

  // eslint-disable-next-line no-inner-declarations
  async function downloadAll() {
    let schemes;
    if (shouldRunCgMlst()) {
      schemes = new CgMlstSchemes({
        downloadFn: downloadFile,
        maxSeqs: 50
      });
    } else {
      schemes = new PubMlstSevenGeneSchemes({
        downloadFn: downloadFile,
        ftpDownloadFn: ftpDownloadFile
      });
    }
    const results = schemes.download();
    logger("info")(`Downloaded ${results.length} schemes`);
  }

  // eslint-disable-next-line no-inner-declarations
  async function indexAll() {
    let schemes;
    if (shouldRunCgMlst()) {
      schemes = new CgMlstSchemes({
        downloadFn: getFromCache,
        maxSeqs: 50
      });
    } else {
      schemes = new PubMlstSevenGeneSchemes({
        downloadFn: getFromCache,
        ftpDownloadFn: getFromCache
      });
    }
    const results = schemes.index();
    logger("info")(`Indexed ${results.length} schemes`);
  }

  if (process.argv[2] === "download")
    downloadAll().catch(fail("error:download"));
  else if (process.argv[2] === "index") indexAll().catch(fail("error:index"));
  else fail("error")(`Usage ${process.argv.slice(0, 2)} download|index`);
}
