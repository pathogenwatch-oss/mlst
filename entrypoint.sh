#!/usr/bin/env bash

cat - > /tmp/sequence.fa

export taxid=$WGSA_organismId
export scheme=$(awk -F ',' -v TAXID=$WGSA_organismId '$1 == TAXID {print $2}' taxIdSchemeMap.csv)
export species=$(awk -F ',' -v TAXID=$WGSA_organismId '$1 == TAXID {print $3}' taxIdSchemeMap.csv)

if [ -z $scheme ]; then
  echo Invalid organism ID 1>&2
  exit 1
fi

echo "Organism has TaxId '$taxid'.  Using the MLST scheme '$scheme' for '$species'" 1>&2

/mlst/bin/mlst --scheme $scheme --quiet --csv /tmp/sequence.fa --novel=/tmp/novel.fa > /tmp/output.csv
./parser.py /tmp/output.csv /tmp/novel.fa
