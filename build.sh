#!/usr/bin/env bash

docker build -t registry.gitlab.com/cgps/wgsa-tasks/mlst:v4 .
docker push registry.gitlab.com/cgps/wgsa-tasks/mlst:v4
