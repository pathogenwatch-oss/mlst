const logger = require("debug");

const { getFromCache } = require("./download");
const { PubMlstSevenGeneSchemes, CgMlstSchemes } = require("./mlst-database");
const { fail } = require("./utils");

function shouldRunCgMlst() {
  const cgMlstFlag = process.env.RUN_CORE_GENOME_MLST || "";
  return ["y", "yes", "true", "1"].indexOf(cgMlstFlag.toLowerCase()) > -1;
}

function getMetadata() {
  const RUN_CORE_GENOME_MLST = shouldRunCgMlst();

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

  if (process.env.WGSA_ORGANISM_TAXID) {
    taxid = process.env.WGSA_ORGANISM_TAXID;
    taxidVariableName = "WGSA_ORGANISM_TAXID";
    alleleMetadata = schemes.read(taxid);
  }

  if (!alleleMetadata && process.env.WGSA_SPECIES_TAXID) {
    taxid = process.env.WGSA_SPECIES_TAXID;
    taxidVariableName = "WGSA_SPECIES_TAXID";
    alleleMetadata = schemes.read(taxid);
  }

  if (!alleleMetadata && process.env.WGSA_GENUS_TAXID) {
    taxid = process.env.WGSA_GENUS_TAXID;
    taxidVariableName = "WGSA_GENUS_TAXID";
    alleleMetadata = schemes.read(taxid);
  } else {
    fail("Missing organism")(
      "Need one of WGSA_ORGANISM_TAXID, WGSA_SPECIES_TAXID or WGSA_GENUS_TAXID"
    );
  }

  logger("params")({ taxidVariableName, taxid });

  return [RUN_CORE_GENOME_MLST, alleleMetadata];
}

module.exports = { getMetadata, shouldRunCgMlst };
