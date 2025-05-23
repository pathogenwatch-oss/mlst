/* eslint-disable no-param-reassign */
const Promise = require("bluebird");
const logger = require("debug");
const fs = require("fs");
const hasha = require("hasha");
const _ = require("lodash");
const mkdirp = require("mkdirp");
const path = require("path");
const readline = require("readline");
const { promisify } = require("util");
const zlib = require("zlib");
const { exec } = require("child_process");
const os = require("os");

const {
	reverseComplement,
	DeferredPromise,
	loadSequencesFromStream
} = require("./utils");

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const execAsync = promisify(exec);

const DEFAULT_INDEX_DIR = "index_dir";

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
	logger("cgps:trace:readGenes")(`Reading genes from ${genesFile}`);
	const contents = await readFileAsync(genesFile, { encoding: "utf8" });
	return JSON.parse(contents).genes;
}


class Scheme {
	constructor(options) {
		this.dataDir = options.dataDir;
		this.indexDir = options.indexDir;
		this.schemePath = options.schemePath;
		this.schemeDir = path.join(this.indexDir, this.schemePath);
		this.alleleLookupPrefixLength = 20;
		this.metadata = options.metadata;
		this.schemeDataFile = path.join(this.dataDir, this.schemePath, "metadata.json");
		this.genes = readGenes(this.schemeDataFile);
	}

	async alleles(gene) {
		const allelesPath = path.join(
			this.dataDir,
			this.schemePath,
			`${gene}.fa.gz`
		);
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
			const alleles = _.map(genes, gene => Number(rowObj[gene]));
			const { ST: st } = rowObj;
			return { st, alleles };
		};
	}

	async profiles() {
		const profilesPath = path.join(
			this.dataDir,
			this.schemePath,
			"profiles.tsv"
		);
		const profiles = {};
		if (!fs.existsSync(profilesPath)) return profiles;

		const genes = await this.genes;
		let rowParser = null;
		const output = new DeferredPromise();

		readline
			.createInterface({
				input: fs.createReadStream(profilesPath)
			})
			.on("line", line => {
				// logger("cgps:trace:index")(`Row ${line}`);
				const row = line.split("\t");
				if (rowParser === null) {
					// This is the header row
					row[0] = "ST"; // Deal with "CGST"
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
				logger("cgps:error")(`Error reading ${profilesPath}`);
				output.reject(err);
			});
		return output.promise;
	}

	async index(maxSeqs = 0) {
		await mkdirp(this.schemeDir, { mode: 0o755 });
		const alleleDb = require("better-sqlite3")(`${this.schemeDir}/allele.db`);
		alleleDb.pragma("synchronous=normal");
		alleleDb.pragma("journal_mode=WAL");
		// eslint-disable-next-line prefer-arrow-callback
		alleleDb.exec(
			"CREATE TABLE IF NOT EXISTS alleles (hash TEXT NOT NULL, gene TEXT NOT NULL, st INTEGER NOT NULL, reverse INTEGER NOT NULL)"
		);
		alleleDb.exec("DELETE FROM alleles");
		alleleDb.exec("DROP INDEX IF EXISTS ix_hash");
		const insert = alleleDb.prepare("INSERT INTO alleles VALUES(?,?,?,?)");
		const insertMany = alleleDb.transaction(alleleList => {
			logger("cgps:trace")(`Inserting ${alleleList.length} alleles`);
			for (const allele of alleleList) insert.run(allele);
		});
		const SLICE_LENGTH = 200;
		// let sliceCounter = 0;
		const genes = await this.genes;
		const allelePaths = {};
		const lengths = {};
		const alleleCounts = {};
		const alleleDictionary = {};

		logger("cgps:info")(
			`Doing ${genes.length} genes in ${SLICE_LENGTH} gene sized sections`
		);
		for (
			let sliceCounter = 0;
			sliceCounter * SLICE_LENGTH < genes.length;
			sliceCounter++
		) {
			const alleleInfo = [];
			const sliceStart = sliceCounter * SLICE_LENGTH;
			const sliceEnd = Math.min(
				(sliceCounter + 1) * SLICE_LENGTH,
				genes.length
			);
			logger("cgps:info")(
				`Slice ${sliceCounter}: from ${sliceStart} to ${sliceEnd - 1} out of ${
					genes.length
				}`
			);

			for (const gene of genes.slice(sliceStart, sliceEnd)) {
				lengths[gene] = {};
				const alleles = await this.alleles(gene); // map of allele_id to allele object
				const selectedReps = {};
				for (const allele of alleles) {
					for (const [ prefix, st, length, hash, reverse ] of this.hash(allele)) {
						if (!(prefix in alleleDictionary)) alleleDictionary[prefix] = {};
						if (!(length in alleleDictionary[prefix]))
							alleleDictionary[prefix][length] = 1;
						alleleInfo.push([ hash, gene, st, reverse ? 1 : 0 ]);
						const alleleCode = allele.seq.slice(0, this.alleleLookupPrefixLength) + allele.seq.slice(-12);
						if (!(length in selectedReps)) selectedReps[length] = {};
						if (!(alleleCode in selectedReps[length]))
							selectedReps[length][alleleCode] = allele;
						lengths[gene][allele.st] = allele.length;
					}
				}
				alleleCounts[gene] = alleles.length;
				// eslint-disable-next-line arrow-body-style
				const reps = Object.keys(selectedReps).reduce(
					(memo, lengthGroup) =>
						memo.concat(Object.values(selectedReps[lengthGroup])),
					[]
				);
				logger("cgps:trace:index")(`${reps.length} selected`);
				allelePaths[gene] = await this.write(gene, reps);
			}
			logger("cgps:info")(
				`Slice ${sliceCounter}: Inserting ${alleleInfo.length} alleles into DB.`
			);
			insertMany(alleleInfo);
		}
		logger("cgps:info")(`Creating index`);
		alleleDb.exec("CREATE INDEX ix_hash ON alleles (hash)");
		logger("cgps:info")(`Vacuuming`);
		alleleDb.exec("VACUUM");
		alleleDb.exec("ANALYZE");
		alleleDb.close();
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
			alleleDictionary,
			schemeSize: (await this.genes).length,
			profiles: await this.profiles()
		};

		logger("cgps:info")(`Writing metadata to ${this.schemeDir}/metadata.json.gz`);
		const metadataPath = path.join(this.schemeDir, "metadata.json.gz");
		const zippedContent = await gzipAsync(JSON.stringify(metadata));
		await writeFileAsync(metadataPath, zippedContent);

		logger("cgps:info")(
			`Indexed ${totalAlleles} alleles from ${genes.length} genes into ${metadataPath}`
		);
		return path.join(this.schemePath, "metadata.json.gz");
	}

	sort(alleles) {
		// Sorts the sequences so that you get a good mix of lengths
		// For example, if sequences == {1: [A1, B1, C1], 3: [D3, E3], 4: [F4], 5:[G5, H5, I5, J5]}
		// this returns: [G5, F4, D3, A1, H5, E3, B1, I5, C1, J5]
		return _(alleles)
			.groupBy("length") // {455: [seq, ...], 460: [seq, ...], ...}
			.toPairs() // [[455, [seq, ...]], [460, [seq, ...]], ...]
			.sortBy(([ length ]) => -length) // [[477, [seq, ...]], [475, [seq, ...]], ...]
			.map(([ , seqs ]) => _.sortBy(seqs, "st")) // [[seq1, seq2, ...], [seq11, seq12, ...], ...]
			.thru(seqs => _.zip(...seqs)) // [[seq1, seq11, ...], [seq2, undefined, ...], ...]
			.flatten() // [seq1, seq11, ..., seq2, undefined, ...]
			.filter(el => typeof el !== "undefined") // [seq1, seq11, ..., seq2, ...]
			.value();
	}

	hash(allele) {
		const { st, length, seq } = allele;
		const hash = hasha(seq, { algorithm: "sha1" });
		const prefix = seq.slice(0, this.alleleLookupPrefixLength);

		const complementarySequence = reverseComplement(seq);
		const rcHash = hasha(complementarySequence, { algorithm: "sha1" });
		const rcPrefix = complementarySequence.slice(
			0,
			this.alleleLookupPrefixLength
		);

		return [
			[ prefix, st, length, hash, false ],
			[ rcPrefix, st, length, rcHash, true ]
		];
	}

	async write(gene, alleles) {
		const outPath = path.join(this.schemeDir, `${gene}.fa.gz`);
		const contents = _(alleles)
			.map(allele => `>${allele.gene}_${allele.st}\n${allele.seq}\n`)
			.join("");
		const zippedContent = await gzipAsync(contents);
		await writeFileAsync(outPath, zippedContent);
		logger("cgps:trace:index")(
			`Wrote ${alleles.length} alleles for ${gene} to ${outPath}`
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

async function updateMetadata(dataDir, { name, scheme }) {
	const metadataPath = path.join(dataDir, `${name}_metadata.json`);
	logger("cgps:trace:index")(`Updating metadata from ${metadataPath}`);

	if (!fs.existsSync(dataDir)) {
		await mkdirp(dataDir, { mode: 0o755 });
	}
	await writeJsonAsync(metadataPath, scheme);
	logger("cgps:trace:index")(`Wrote metadata to ${metadataPath}`);
}

async function readSchemeMetadata(scheme, indexDir = DEFAULT_INDEX_DIR) {
	const metadataPath = path.join(indexDir, `${scheme}_metadata.json`);
	logger("cgps:debug")(`Looking up scheme metadata path for ${scheme} at ${metadataPath}`);
	if (fs.existsSync(metadataPath)) {
		const metadata = await readJsonAsync(metadataPath);
		logger("cgps:debug")(`Metadata: ${JSON.stringify(metadata)}`);
		return metadata;
	}
	return undefined;
}

function getAlleleDbPath(schemeDir, indexDir = DEFAULT_INDEX_DIR) {
	return path.join(indexDir, schemeDir, "allele.db");
}

async function readSchemeDetails(
	schemeMetadataPath,
	indexDir = DEFAULT_INDEX_DIR
) {
	try {
		// Links in the schemeMetadata are relative to the indexDir
		const zippedSchemeDetails = await readFileAsync(
			path.join(indexDir, schemeMetadataPath)
		);
		const schemeDetails = JSON.parse(await gunzipAsync(zippedSchemeDetails));
		for (const allele of Object.keys(schemeDetails.allelePaths)) {
			schemeDetails.allelePaths[allele] = path.join(
				indexDir,
				schemeDetails.allelePaths[allele]
			);
		}
		return schemeDetails;
	} catch (err) {
		return undefined;
	}
}

function parseAlleleName(allele) {
	try {
		const matches = /^(.+)_([0-9]+(\.[0-9]+)?)$/.exec(allele);
		const [ gene, st ] = matches.slice(1);
		return { gene, st: Number(st) };
	} catch (err) {
		logger("cgps:error")(`Couldn't parse gene and st from ${allele}`);
		throw err;
	}
}

async function readSchemeUpdatedDate(dir) {
	try {
		const text = await readFileAsync(path.join(dir, "metadata.json"), "utf8");
		return JSON.parse(text).last_updated;
	} catch (err) {
		return "0";
	}
}

async function main() {
	const yargs = require("yargs");
	const { argv } = yargs
		.usage(
			"Usage: $0 [--type FILTER_BY_TYPE] [--scheme SPECIFIC_SCHEME] [--index WHERE_TO_PUT_THE_INDEX] --database WHERE_TO_FIND_SCHEMES"
		)
		.option("type", {
			alias: "t",
			describe: "type of schemes to index",
			type: "string"
		})
		.option("scheme", {
			alias: "s",
			describe: "shortname of the scheme to build",
			type: "string",
			array: true
		})
		.option("index", {
			alias: "i",
			describe: "directory for the index",
			type: "string",
			default: DEFAULT_INDEX_DIR
		})
		.option("database", {
			alias: "d",
			describe: "directory with the scheme data",
			type: "string",
			demandOption: true
		})
		.help("h")
		.alias("h", "help");

	let { schemes } = await readJsonAsync(
		path.join(argv.database, "schemes.json")
	);
	await mkdirp(argv.index);
	if (argv.scheme[0] === "IGNORE") {
		argv.scheme.shift();
		if (argv.scheme.length === 0) {
			argv.scheme = undefined;
		}
	}
	if (argv.scheme && argv.scheme[0] !== "IGNORE") {
		console.log(argv.scheme);
		schemes = _.filter(schemes, s => argv.scheme.includes(s.shortname));
		const found = new Set(_.map(schemes, "shortname"));
		for (const scheme of argv.scheme) {
			if (!found.has(scheme)) throw Error(`Could not find ${scheme}`);
		}
	}
	if (argv.type && argv.type[0] !== "IGNORE") {
		schemes = _.filter(schemes, s => s.type === argv.type);
	}
	logger("cgps:info")(`Found ${schemes.length} schemes`);

	if (schemes.length > 1) {
		const concurrency =
			os.cpus().length > 2 ? os.cpus().length - 1 : os.cpus().length;
		logger("cgps:info")(`Concurrency: ${concurrency}`);
		await Promise.map(
			schemes,
			async schemeData => {
				const opts = [
					`--scheme=${schemeData.shortname}`,
					`--database=${argv.database}`,
					`--index=${argv.index}`
				];
				if ("type" in argv) {
					opts.push(`--type=${argv.type}`);
				}
				if ("max-sequences" in argv) {
					opts.push(`--max-sequences=${argv["max-sequences"]}`);
				}
				logger("cgps:info")(`Opts: ${JSON.stringify(opts)}`);
				const { stdout, stderr } = await execAsync(
					`npm run index -- ${opts.join(" ")}`
				);
				console.log("stdout:", stdout);
				console.log("stderr:", stderr);
			},
			{ concurrency }
		);
	} else {
		const schemeData = schemes[0];
		// This is to deal with paths that have erroneously included the database root directory.
		console.log("Checking db_path:", schemeData.db_path);
		if (schemeData.db_path.startsWith("db/")) {
			schemeData.db_path = schemeData.db_path.replace("db/", "");
			console.log("Adjusted db_path:", schemeData.db_path);
		}
		// for (const schemeData of schemes) {
		const { targets, ...metadata } = schemeData;
		const {
			name: schemeName,
			url,
			shortname,
			type,
			host,
			host_path: hostPath,
			db_path: schemePath,
			scheme_id: schemeId,
			last_updated: lastUpdated
		} = metadata;
		const scheme = new Scheme({
			dataDir: argv.database,
			indexDir: argv.index,
			schemePath,
			metadata
		});
		logger("cgps:info")(`Indexing ${schemeData.shortname}`);
		const schemeIndexPath = await scheme.index();
		await updateMetadata(argv.index, {
			name: shortname,
			scheme: {
				path: schemeIndexPath,
				schemeName,
				url,
				type,
				shortname,
				host,
				hostPath,
        schemePath,
        schemeId,
        lastUpdated,
        targets
			}
		});
		logger("cgps:trace:index")(`Updated metadata for ${schemeData.shortname}`);
	}
}

module.exports = {
	readSchemeMetadata,
	readSchemeDetails,
	getAlleleDbPath,
	parseAlleleName,
	Scheme,
	DEFAULT_INDEX_DIR
};

if (require.main === module) {
	const { fail } = require("./utils");

	process.on("unhandledRejection", reason =>
		fail("unhandledRejection")(reason)
	);

	main()
		.then(() => logger("cgps:info")("Indexing complete"))
		.catch(err => fail("error")(err));
}
