#!/usr/bin/env bash

cat - > /tmp/sequence.fa

export taxid=$WGSA_organismId

/usr/local/bin/node /usr/local/mlst/index.js $taxid /tmp/sequence.fa
