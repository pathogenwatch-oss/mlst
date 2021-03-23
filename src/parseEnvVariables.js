const logger = require("debug");

const { fail } = require("./utils");
const { lookupSchemeMetadataPath, readSchemeDetails, readSchemePrefixes } = require("./mlst-database");

function shouldRunCgMlst(taxidEnvVariables = process.env) {
  const cgMlstFlag = taxidEnvVariables.RUN_CORE_GENOME_MLST || "";
  return ["y", "yes", "true", "1"].indexOf(cgMlstFlag.toLowerCase()) > -1;
}

async function getMetadataPath(taxidEnvVariables = process.env) {
  let taxid;
  let schemeMetadataPath;

  const {
    TAXID,
    ORGANISM_TAXID,
    SPECIES_TAXID,
    GENUS_TAXID,
  } = taxidEnvVariables;

  const variablesNames = [
    "TAXID",
    "ORGANISM_TAXID",
    "SPECIES_TAXID",
    "GENUS_TAXID",
  ]

  const variableValues = [
    TAXID,
    ORGANISM_TAXID,
    SPECIES_TAXID,
    GENUS_TAXID,
  ]

  for (let i=0; i<variableValues.length; i++) {
    if (variableValues[i] !== undefined) {
      taxid = variableValues[i];
      schemeMetadataPath = await lookupSchemeMetadataPath(taxid)
      if (schemeMetadataPath !== undefined) {
        logger("cgps:params")({ [variablesNames[i]]: taxid, shouldRunCgMlst: shouldRunCgMlst(taxidEnvVariables) });
        return schemeMetadataPath
      } else {
        logger("cgps:debug")(`No scheme for ${taxid}`)
      }
    }
  }

  return fail("Missing organism")(
    `Need one of ${variablesNames.join(',')}`
  );
}

module.exports = { getMetadataPath, shouldRunCgMlst };
