#!/usr/bin/env bash

PROXY_VARIABLES=$(env | grep -iE '^https?_proxy=')
if [ -z "$PROXY_VARIABLES" ]; then
  PROXY_VARIABLES=''
else
  PROXY_VARIABLES=$(echo "$PROXY_VARIABLES" | sed 's/^/--build-arg /' | tr '\n' ' ')
fi

docker build \
  $PROXY_VARIABLES \
  -t registry.gitlab.com/cgps/wgsa/tasks/mlst:v4 \
  .
