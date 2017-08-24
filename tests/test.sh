#!/bin/bash

set -eu -o pipefail

function getCode() {
  cat | python -c "import json, sys; print(json.load(sys.stdin)['code'])"
}

function now() {
  echo $(($(date +%s%N)/1000000))
}

function runMlst() {
  name=$1
  eval "export $2"
  start=$(now)
  cat data/$name.fasta | env node /usr/local/mlst/index.js
  end=$(now)
  duration=$(($end - $start))
  echo "$name took $duration ms to process" 1>&2
}

errors=0

while read -r name arguments; do
  actual_code=$(runMlst $name $arguments | getCode);
  expected_code=$(cat data/$name.json | getCode);
  echo "$name $expected_code $actual_code";
  if [[ "$actual_code" != "$expected_code" ]]; then
    errors=$(($errors+1));
  fi
done <<- 'EOF'
  gono 'WGSA_GENUS_TAXID=482'
  shaemolyticus 'WGSA_SPECIES_TAXID=1283'
  saureus_duplicate 'WGSA_SPECIES_TAXID=1280'
  saureus_missing 'WGSA_SPECIES_TAXID=1280'
  saureus_novel 'WGSA_SPECIES_TAXID=1280'
  saureus_bad_names 'WGSA_SPECIES_TAXID=1280'
  typhi 'WGSA_SPECIES_TAXID=28901'
EOF

echo "There were $errors errors" 1>&2
if [[ "$errors" -gt 0 ]]; then
  exit 1
fi
