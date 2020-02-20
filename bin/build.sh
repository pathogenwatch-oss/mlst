#!/bin/bash

set -eu -o pipefail

TOKEN=${TOKEN:-"missing"}

if [[ "$TOKEN" == "missing" ]]; then
  echo "Please get a token from https://gitlab.com/cgps/cgps-mlst/-/settings/ci_cd#js-pipeline-triggers and set the env variable 'TOKEN'";
  exit 1
fi

COMMIT=${1:-HEAD}
TAG=$(git describe --exact-match $COMMIT 2>/dev/null || echo "missing")

if [[ "$TAG" == "missing" ]]; then
  echo "Please run just after tagging a release or specify a tag to build";
  exit 1
fi

# Build MLST
curl -X POST \
     -F token=$TOKEN \
     -F "ref=$TAG" \
     -F "variables[RUN_CORE_GENOME_MLST]=no" \
     https://gitlab.com/api/v4/projects/3045659/trigger/pipeline

# Build Alternative MLST
curl -X POST \
     -F token=$TOKEN \
     -F "ref=$TAG" \
     -F "variables[INDEX_PARAMS]=--type alternative_mlst" \
     -F "variables[SCHEME_NAME]=alternative-mlst" \
     https://gitlab.com/api/v4/projects/3045659/trigger/pipeline

# Build ngstar
curl -X POST \
     -F token=$TOKEN \
     -F "ref=$TAG" \
     -F "variables[INDEX_PARAMS]=--scheme ngstar" \
     -F "variables[SCHEME_NAME]=ngstar" \
     https://gitlab.com/api/v4/projects/3045659/trigger/pipeline

# Build CGMLST
curl -X POST \
     -F token=$TOKEN \
     -F "ref=$TAG" \
     -F "variables[RUN_CORE_GENOME_MLST]=yes" \
     https://gitlab.com/api/v4/projects/3045659/trigger/pipeline

