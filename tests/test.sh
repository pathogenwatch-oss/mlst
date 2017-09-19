#!/bin/bash

set -eu -o pipefail

function getCode() {
  cat | jq -r '.code'
}

function getSt() {
  cat | jq -r '.st'
}

function now() {
  echo $(($(date +%s%N)/1000000))
}

function runMlst() {
  sequence=$1
  name=$(basename $sequence '.fasta')
  eval "export $2"
  start=$(now)
  cat $sequence | env node /usr/local/mlst/index.js
  end=$(now)
  duration=$(($end - $start))
  echo "[$(date)] $name took $duration ms to process" 1>&2
}

errors=0
if [ -z "${RUN_CORE_GENOME_MLST:-}" ]; then
  while read -r name arguments; do
    actual_code=$(runMlst data/${name}.fasta $arguments | getCode);
    expected_code=$(cat data/$name.json | getCode);
    echo "[$(date)] $name $expected_code $actual_code";
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
    saureus_synthetic_ones 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_ones_duplicate 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_ones_duplicate_different_novel 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_ones_duplicate_identical_novel 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_ones_duplicate_one_novel 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_last 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_last_duplicate 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_last_duplicate_different_novel 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_last_duplicate_identical_novel 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_last_duplicate_one_novel 'WGSA_SPECIES_TAXID=1280'
EOF

  find data/saureus_data/ -name '*.mlst.json' | while read results; do
    sequence_name=$(basename $results '.mlst.json')
    echo "[$(date)] Getting types for $sequence_name";
    actual_st=$(runMlst data/saureus_data/$sequence_name 'WGSA_ORGANISM_TAXID=1280' | getSt);
    expected_st=$(cat $results | getSt);
    echo "[$(date)] $sequence_name $expected_st $actual_st";
    if [[ "$actual_st" != "$expected_st" ]]; then
      errors=$(($errors+1));
    fi
  done
  
else
  find data/saureus_data/ -name '*.cgMlst.json' | while read results; do
    sequence_name=$(basename $results '.cgMlst.json')
    echo "[$(date)] Getting types for $sequence_name";
    actual_st=$(runMlst data/saureus_data/$sequence_name 'WGSA_ORGANISM_TAXID=1280 RUN_CORE_GENOME_MLST=yes' | getSt);
    expected_st=$(cat $results | getSt);
    echo "[$(date)] $sequence_name $expected_st $actual_st";
    if [[ "$actual_st" != "$expected_st" ]]; then
      errors=$(($errors+1));
    fi
  done
fi

echo "[$(date)] There were $errors errors" 1>&2
if [[ "$errors" -gt 0 ]]; then
  exit 1
fi
