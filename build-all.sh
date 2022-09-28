#!/usr/bin/env bash
set -e pipefail
# e.g. ./build-all.sh v1.1.1 2020-04-27
# or ./build-all.sh latest latest to live on the edge.

# keep track of the last executed command
trap 'last_command=$current_command; current_command=$BASH_COMMAND' DEBUG
# echo an error message before exiting
trap 'echo "\"${last_command}\" command filed with exit code $?."' EXIT

set -o allexport
source .env
set +o allexport

if docker pull registry.gitlab.com/cgps/cgps-mlst/mlst-code:"${CODE_VERSION}"; then
  echo "${CODE_VERSION} already exists."
else
  echo "Building mlst code ${CODE_VERSION}"
  docker build --rm -t registry.gitlab.com/cgps/cgps-mlst/mlst-code:"${CODE_VERSION}" -f Dockerfile.code .
  docker push registry.gitlab.com/cgps/cgps-mlst/mlst-code:"${CODE_VERSION}"
fi

DATA_VERSION=${DB_TAG}-${CODE_VERSION}

if docker pull registry.gitlab.com/cgps/cgps-mlst/ngstar-data:"${DATA_VERSION}"; then
  echo "${DATA_VERSION} already exists."
else
  echo "Building mlst data ${DATA_VERSION}"
  docker build --rm --build-arg DB_TAG="${DB_TAG}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg TYPE=mlst -t registry.gitlab.com/cgps/cgps-mlst/mlst-data:"${DATA_VERSION}" -f Dockerfile.schemes .
  docker build --rm --build-arg DB_TAG="${DB_TAG}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg TYPE=cgmlst -t registry.gitlab.com/cgps/cgps-mlst/cgmlst-data:"${DATA_VERSION}" -f Dockerfile.schemes .
  docker build --rm --build-arg DB_TAG="${DB_TAG}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg TYPE=alternative_mlst -t registry.gitlab.com/cgps/cgps-mlst/mlst2-data:"${DATA_VERSION}" -f Dockerfile.schemes .
  docker build --rm --build-arg DB_TAG="${DB_TAG}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg TYPE=ngstar -t registry.gitlab.com/cgps/cgps-mlst/ngstar-data:"${DATA_VERSION}" -f Dockerfile.schemes .
  docker push registry.gitlab.com/cgps/cgps-mlst/mlst-data:"${DATA_VERSION}"
  docker push registry.gitlab.com/cgps/cgps-mlst/cgmlst-data:"${DATA_VERSION}"
  docker push registry.gitlab.com/cgps/cgps-mlst/mlst2-data:"${DATA_VERSION}"
  docker push registry.gitlab.com/cgps/cgps-mlst/ngstar-data:"${DATA_VERSION}"
fi

echo "Combining code and data repositories"

if docker pull registry.gitlab.com/cgps/cgps-mlst/mlst:"${DATA_VERSION}"; then
  echo "${DATA_VERSION} already exists."
else
  echo "Building integrated image ${DATA_VERSION}"
  docker build --rm --build-arg DATA_NAME=mlst --build-arg DATA_VERSION="${DATA_VERSION}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg RUN_CORE_GENOME_MLST=no -t registry.gitlab.com/cgps/cgps-mlst/mlst:"${DATA_VERSION}" .
  docker build --rm --build-arg DATA_NAME=cgmlst --build-arg DATA_VERSION="${DATA_VERSION}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg RUN_CORE_GENOME_MLST=yes -t registry.gitlab.com/cgps/cgps-mlst/cgmlst:"${DATA_VERSION}" .
  docker build --rm --build-arg DATA_NAME=mlst2 --build-arg DATA_VERSION="${DATA_VERSION}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg RUN_CORE_GENOME_MLST=yes -t registry.gitlab.com/cgps/cgps-mlst/mlst2:"${DATA_VERSION}" .
  docker build --rm --build-arg DATA_NAME=ngstar --build-arg DATA_VERSION="${DATA_VERSION}" --build-arg CODE_VERSION="${CODE_VERSION}" --build-arg RUN_CORE_GENOME_MLST=yes -t registry.gitlab.com/cgps/cgps-mlst/ngstar:"${DATA_VERSION}" .
  docker push registry.gitlab.com/cgps/cgps-mlst/mlst:"${DATA_VERSION}"
  docker push registry.gitlab.com/cgps/cgps-mlst/cgmlst:"${DATA_VERSION}"
  docker push registry.gitlab.com/cgps/cgps-mlst/mlst2:"${DATA_VERSION}"
  docker push registry.gitlab.com/cgps/cgps-mlst/ngstar:"${DATA_VERSION}"
fi
