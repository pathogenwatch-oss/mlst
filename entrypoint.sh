#!/usr/bin/env bash

cat - > /tmp/file

case "$WGSA_organismId" in
  666)
    scheme=vcholerae
    ;;

  1280)
    scheme=saureus
      ;;

  1313)
    scheme=spneumoniae
    ;;

  90370)
    scheme=senterica
      ;;

  *)
    echo Invalid organism ID
    exit 1
esac

/mlst/bin/mlst --scheme $scheme --quiet --csv /tmp/file | node /parser.js
