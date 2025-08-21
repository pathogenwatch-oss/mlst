#!/usr/bin/env bash

set -euo pipefail

# Function to report errors
error_report() {
    echo "Error: Command failed: $BASH_COMMAND" >&2
}

trap 'error_report' ERR

# Create the encoded FASTA
if ! sanitiser -store /mapping_store encode - > /tmp/tmp.fa; then
    echo "Error: Failed to create encoded FASTA file." >&2
    exit 1
fi

# Run MLST
if  ! cat /tmp/tmp.fa | /usr/local/bin/node /usr/local/mlst/index.js | sanitiser -store /mapping_store -json decode -; then
    echo "Error: Failed to run." >&2
    exit 1
fi