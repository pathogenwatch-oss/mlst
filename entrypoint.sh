#!/usr/bin/env bash

cat - > /tmp/sequence.fa

/usr/local/bin/node /usr/local/mlst/index.js /tmp/sequence.fa
