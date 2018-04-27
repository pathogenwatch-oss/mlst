const logger = require("debug");

const {
  PubMlstSevenGenomeSchemes,
  CgMlstMetadata
} = require("./mlst-database");
const { fail } = require("./utils");

function getMetadata(DATA_DIR) {
  const RUN_CORE_GENOME_MLST =
  ["y", "yes", "true", "1"].indexOf(process.env.RUN_CORE_GENOME_MLST.toLowerCase()) > -1;

  let metadataSchemes;
  if (RUN_CORE_GENOME_MLST) {
    metadataSchemes = new CgMlstMetadata(DATA_DIR);
  } else {
    metadataSchemes = new PubMlstSevenGenomeSchemes(DATA_DIR);
  }

  let taxid;
  let taxidVariableName;
  let alleleMetadata;
  if (process.env.WGSA_ORGANISM_TAXID) {
    taxid = process.env.WGSA_ORGANISM_TAXID;
    taxidVariableName = "WGSA_ORGANISM_TAXID";
    alleleMetadata = metadataSchemes.read(taxid);
  } else if (process.env.WGSA_SPECIES_TAXID) {
    taxid = process.env.WGSA_SPECIES_TAXID;
    taxidVariableName = "WGSA_SPECIES_TAXID";
    alleleMetadata = metadataSchemes.read(taxid);
  } else if (process.env.WGSA_GENUS_TAXID) {
    taxid = process.env.WGSA_GENUS_TAXID;
    taxidVariableName = "WGSA_GENUS_TAXID";
    alleleMetadata = metadataSchemes.read(taxid);
  } else {
    fail("Missing organism")(
      "Need one of WGSA_ORGANISM_TAXID, WGSA_SPECIES_TAXID or WGSA_GENUS_TAXID"
    );
  }

  logger("params")({ taxidVariableName, taxid });

  return [RUN_CORE_GENOME_MLST, alleleMetadata];
}

module.exports = { getMetadata };
