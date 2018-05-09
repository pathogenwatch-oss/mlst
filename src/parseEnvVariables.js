const logger = require("debug");

const { getFromCache } = require("./download");
const { PubMlstSevenGeneSchemes, CgMlstSchemes } = require("./mlst-database");
const { fail } = require("./utils");

function shouldRunCgMlst(taxidEnvVariables = process.env) {
  const cgMlstFlag = taxidEnvVariables.RUN_CORE_GENOME_MLST || "";
  return ["y", "yes", "true", "1"].indexOf(cgMlstFlag.toLowerCase()) > -1;
}

async function getMetadata(taxidEnvVariables = process.env) {
  const RUN_CORE_GENOME_MLST = shouldRunCgMlst(taxidEnvVariables);

  let schemes;
  if (RUN_CORE_GENOME_MLST) {
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

  let taxid;
  let taxidVariableName;
  let alleleMetadata;

  if (taxidEnvVariables.WGSA_ORGANISM_TAXID) {
    taxid = taxidEnvVariables.WGSA_ORGANISM_TAXID;
    taxidVariableName = "WGSA_ORGANISM_TAXID";
    alleleMetadata = await schemes.read(taxid);
  }

  if (!alleleMetadata && taxidEnvVariables.WGSA_SPECIES_TAXID) {
    taxid = taxidEnvVariables.WGSA_SPECIES_TAXID;
    taxidVariableName = "WGSA_SPECIES_TAXID";
    alleleMetadata = await schemes.read(taxid);
  }

  if (!alleleMetadata && taxidEnvVariables.WGSA_GENUS_TAXID) {
    taxid = taxidEnvVariables.WGSA_GENUS_TAXID;
    taxidVariableName = "WGSA_GENUS_TAXID";
    alleleMetadata = await schemes.read(taxid);
  }

  if (!alleleMetadata) {
    fail("Missing organism")(
      "Need one of WGSA_ORGANISM_TAXID, WGSA_SPECIES_TAXID or WGSA_GENUS_TAXID"
    );
  }

  logger("params")({ taxidVariableName, taxid });

  return alleleMetadata;
}

module.exports = { getMetadata, shouldRunCgMlst };
