const logger = require("debug");

const { fail } = require("./utils");
const { readSchemeMetadata, DEFAULT_INDEX_DIR } = require("./mlst-database");

function getIndexDir({ INDEX_DIR } = process.env) {
	return !!INDEX_DIR ? INDEX_DIR : DEFAULT_INDEX_DIR;
}

async function getSchemeMetadata(envVariables = process.env) {
	const { SCHEME, INDEX_DIR } = envVariables;
	const indexDir = !!INDEX_DIR ? INDEX_DIR : DEFAULT_INDEX_DIR;
	const schemeMetadata = readSchemeMetadata(SCHEME, indexDir);
	if (schemeMetadata !== undefined) {
		return schemeMetadata;
	}
	logger("cgps:debug")(`No scheme for ${SCHEME}`);
	return fail("Missing organism")(
		`No scheme was supplied or it (${SCHEME}) was not found in the index directory ${indexDir}`
	);
}

module.exports = { getSchemeMetadata, getIndexDir };
