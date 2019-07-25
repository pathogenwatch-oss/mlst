#!/bin/bash

set -eu -o pipefail

DB_DIR=$1

if [[ -d $DB_DIR ]]; then
  echo "Pulling database"
  cd $DB_DIR && git pull;
else
  git clone https://gitlab.com/cgps/cgps-typing-databases.git $DB_DIR
fi