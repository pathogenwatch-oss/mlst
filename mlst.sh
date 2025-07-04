#!/bin/bash

# Check if all two parameters are provided
if [ $# -ne 4 ]; then
    echo "Usage: $0 <input_fasta_file> <output_json_file> <scheme_name> <index_dir>"
    exit 1
fi

# Read in parameters from command line
INPUT_FASTA=$1
OUTPUT_JSON=$2
SCHEME=$3
INDEX_DIR=$4

# Export parameters as environment variables. These are read in by the MLST tool.
export SCHEME=$SCHEME
export INDEX_DIR=$INDEX_DIR

# Run the MLST tool
cat $INPUT_FASTA | node index.js > $OUTPUT_JSON
