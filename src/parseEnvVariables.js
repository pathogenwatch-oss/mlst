const logger = require("debug");

const { fail } = require("./utils");
const { readScheme } = require("./mlst-database");

function shouldRunCgMlst(taxidEnvVariables = process.env) {
  const cgMlstFlag = taxidEnvVariables.RUN_CORE_GENOME_MLST || "";
  return ["y", "yes", "true", "1"].indexOf(cgMlstFlag.toLowerCase()) > -1;
}

async function getMetadata(taxidEnvVariables = process.env) {
  let taxid;
  let schemeMetadata;

  const {
    TAXID,
    ORGANISM_TAXID,
    PATHOGENWATCH_ORGANISM_TAXID,
    WGSA_ORGANISM_TAXID,
    SPECIES_TAXID,
    PATHOGENWATCH_SPECIES_TAXID,
    WGSA_SPECIES_TAXID,
    GENUS_TAXID,
    PATHOGENWATCH_GENUS_TAXID,
    WGSA_GENUS_TAXID
  } = taxidEnvVariables;

  const variablesNames = [
    "TAXID",
    "ORGANISM_TAXID",
    "PATHOGENWATCH_ORGANISM_TAXID",
    "WGSA_ORGANISM_TAXID",
    "SPECIES_TAXID",
    "PATHOGENWATCH_SPECIES_TAXID",
    "WGSA_SPECIES_TAXID",
    "GENUS_TAXID",
    "PATHOGENWATCH_GENUS_TAXID",
    "WGSA_GENUS_TAXID"
  ]

  const variableValues = [
    TAXID,
    ORGANISM_TAXID,
    PATHOGENWATCH_ORGANISM_TAXID,
    WGSA_ORGANISM_TAXID,
    SPECIES_TAXID,
    PATHOGENWATCH_SPECIES_TAXID,
    WGSA_SPECIES_TAXID,
    GENUS_TAXID,
    PATHOGENWATCH_GENUS_TAXID,
    WGSA_GENUS_TAXID
  ]

  for (let i=0; i<variableValues.length; i++) {
    if (variableValues[i] !== undefined) {
      taxid = variableValues[i];
      schemeMetadata = await readScheme(taxid)
      if (schemeMetadata !== undefined) {
        logger("cgps:params")({ [variablesNames[i]]: taxid, shouldRunCgMlst: shouldRunCgMlst() });
        return schemeMetadata
      } else {
        logger("cgps:debug")(`No scheme for ${taxid}`)
      }
    }
  }

  return fail("Missing organism")(
    `Need one of ${variablesNames.join(',')}`
  );
}

module.exports = { getMetadata, shouldRunCgMlst };
