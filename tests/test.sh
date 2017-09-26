#!/bin/bash

set -eu -o pipefail

function diffResults() {
  original=$1
  new=$2
  original_st=$(echo "$original" | jq -r '.st')
  new_st=$(echo "$new" | jq -r '.st')
  if [[ "$original_st" != "$new_st" ]]; then
    echo "Expected $original_st == $new_st" 1>&2
    return 1
  fi

  original_code=$(echo "$original" | jq -r '.code')
  new_code=$(echo "$new" | jq -r '.code')
  if [[ "$original_code" != "$new_code" ]]; then
    echo "Expected $original_code == $new_code" 1>&2
    return 1
  fi

  original_alleles=$(echo "$original" | jq -r -S .alleles)
  new_alleles=$(echo "$new" | jq -r -S .alleles)
  differences=$(diff --suppress-common-lines --ignore-all-space --side-by-side <(echo "$original_alleles") <(echo "$new_alleles"))
  differences_count=$(echo "$differences" | wc -l)
  if [ "$differences_count" -gt 1 ]; then
    echo "$differences_count differences between allele representation:" 1>&2
    echo "$differences" | head -30 1>&2
    return 1
  fi

  echo "Passed" 1>&2
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
    echo "[$(date)] Testing $name" 2>&1;
    results=$(runMlst data/${name}.fasta $arguments);
    expected_results=$(cat data/$name.json);
    diffResults "$expected_results" "$results" || errors=$(($errors+1))
  done <<- 'EOF'
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
    saureus_synthetic_novel_reversed_duplicates 'WGSA_SPECIES_TAXID=1280'
    saureus_synthetic_ones_reversed 'WGSA_SPECIES_TAXID=1280'
    saureus_duplicate 'WGSA_SPECIES_TAXID=1280'
    saureus_missing 'WGSA_SPECIES_TAXID=1280'
    saureus_novel 'WGSA_SPECIES_TAXID=1280'
    saureus_bad_names 'WGSA_SPECIES_TAXID=1280'
    gono 'WGSA_GENUS_TAXID=482'
    shaemolyticus 'WGSA_SPECIES_TAXID=1283'
    typhi 'WGSA_SPECIES_TAXID=28901'
EOF

  find data/saureus_data/ -name '*.mlst.json' | while read results_path; do
    sequence_name=$(basename $results_path '.mlst.json')
    echo "[$(date)] Testing $sequence_name" 2>&1;
    results=$(runMlst data/saureus_data/$sequence_name 'WGSA_ORGANISM_TAXID=1280');
    expected_results=$(cat $results_path);
    diffResults "$expected_results" "$results" || errors=$(($errors+1))
  done
  
else
  find data/saureus_data/ -name '*.cgMlst.json' | while read results_path; do
    sequence_name=$(basename $results_path '.cgMlst.json')
    echo "[$(date)] Testing $sequence_name" 2>&1;
    results=$(runMlst data/saureus_data/$sequence_name 'WGSA_ORGANISM_TAXID=1280 RUN_CORE_GENOME_MLST=yes');
    expected_results=$(cat $results_path);
    diffResults "$expected_results" "$results" || errors=$(($errors+1))
  done
fi

echo "[$(date)] There were $errors errors" 1>&2
if [[ "$errors" -gt 0 ]]; then
  exit 1
fi
