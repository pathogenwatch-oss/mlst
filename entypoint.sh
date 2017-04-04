#!/usr/bin/env bash

cat - > /tmp/file

get_sequence_type -s 'Staphylococcus_aureus' /tmp/file

node /parser.js /data/mlst_results.allele.csv
