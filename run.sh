#!/usr/bin/env bash

echo testing col.fasta
echo expected:
cat test/col.json
echo reported:
cat test/col.fasta | docker run -i wgsa-services-mlst:v1
