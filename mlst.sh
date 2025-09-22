#!/bin/bash

# This script provides a simple command line interface to the MLST tool.

set -euo pipefail  # Exit on error, undefined variables, and pipe failures

# Function to display usage
usage() {
    echo "Usage: $0 <input_fasta_file> <output_json_file> <scheme_name> <index_dir>"
    echo ""
    echo "Arguments:"
    echo "  input_fasta_file  Path to input FASTA file"
    echo "  output_json_file  Path to output JSON file"
    echo "  scheme_name       MLST scheme name"
    echo "  index_dir         Directory containing MLST index files"
    echo ""
    echo "Example:"
    echo "  $0 sample.fasta results.json saureus_1 /path/to/index"
    exit 1
}

# Function to log messages with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

# Function to check if file exists and is readable
check_file() {
    local file="$1"
    local description="$2"

    if [[ ! -f "$file" ]]; then
        log "ERROR: $description file does not exist: $file"
        exit 1
    fi

    if [[ ! -r "$file" ]]; then
        log "ERROR: $description file is not readable: $file"
        exit 1
    fi
}

# Function to check if directory exists and is readable
check_directory() {
    local dir="$1"
    local description="$2"

    if [[ ! -d "$dir" ]]; then
        log "ERROR: $description directory does not exist: $dir"
        exit 1
    fi

    if [[ ! -r "$dir" ]]; then
        log "ERROR: $description directory is not readable: $dir"
        exit 1
    fi
}

# Check if help is requested
if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
    usage
fi

# Check if correct number of parameters are provided
if [[ $# -ne 4 ]]; then
    log "ERROR: Expected 4 arguments, got $#"
    usage
fi

# Read in parameters from command line
INPUT_FASTA="$1"
OUTPUT_JSON="$2"
SCHEME="$3"
INDEX_DIR="$4"

log "Starting MLST analysis"
log "Input FASTA: $INPUT_FASTA"
log "Output JSON: $OUTPUT_JSON"
log "Scheme: $SCHEME"
log "Index directory: $INDEX_DIR"

# Validate inputs
check_file "$INPUT_FASTA" "Input FASTA"
check_directory "$INDEX_DIR" "Index"

# Check if output directory exists and is writable
OUTPUT_DIR=$(dirname "$OUTPUT_JSON")
if [[ ! -d "$OUTPUT_DIR" ]]; then
    log "ERROR: Output directory does not exist: $OUTPUT_DIR"
    exit 1
fi

if [[ ! -w "$OUTPUT_DIR" ]]; then
    log "ERROR: Output directory is not writable: $OUTPUT_DIR"
    exit 1
fi

# Check if node and index.js exist
if ! command -v node &> /dev/null; then
    log "ERROR: Node.js is not installed or not in PATH"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEX_JS="$SCRIPT_DIR/index.js"

if [[ ! -f "$INDEX_JS" ]]; then
    log "ERROR: index.js not found at: $INDEX_JS"
    exit 1
fi

# Export parameters as environment variables
export SCHEME="$SCHEME"
export INDEX_DIR="$INDEX_DIR"

log "Running MLST analysis..."

# Run the MLST tool with error handling
if ! cat "$INPUT_FASTA" | node "$INDEX_JS" > "$OUTPUT_JSON"; then
    log "ERROR: MLST analysis failed"
    # Clean up partial output file
    [[ -f "$OUTPUT_JSON" ]] && rm -f "$OUTPUT_JSON"
    exit 1
fi

# Verify output was created and is valid JSON
if [[ ! -f "$OUTPUT_JSON" ]]; then
    log "ERROR: Output file was not created: $OUTPUT_JSON"
    exit 1
fi

if [[ ! -s "$OUTPUT_JSON" ]]; then
    log "ERROR: Output file is empty: $OUTPUT_JSON"
    exit 1
fi

# Basic JSON validation
if ! python3 -m json.tool "$OUTPUT_JSON" > /dev/null 2>&1; then
    log "WARNING: Output file may not be valid JSON: $OUTPUT_JSON"
fi

log "MLST analysis completed successfully"
log "Results written to: $OUTPUT_JSON"