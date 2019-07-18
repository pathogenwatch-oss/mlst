FROM ubuntu:latest as blast_build

RUN apt-get update && apt-get install -y wget tar
RUN wget ftp://ftp.ncbi.nlm.nih.gov/blast/executables/LATEST/ncbi-blast-2.9.0+-x64-linux.tar.gz
RUN tar xzvf ncbi-blast-2.9.0+-x64-linux.tar.gz
RUN mv ncbi-blast-2.9.0+/bin /blast

FROM node:10-slim as prod_build

WORKDIR /usr/local/mlst
COPY    --from=blast_build /blast/blastn /blast/makeblastdb /usr/local/bin/

COPY    package.json yarn.lock /usr/local/mlst/
RUN     yarn install --production

COPY    *.js *.json ./
COPY    src src/
COPY    index_dir index_dir/
SHELL   ["/bin/sh", "-c"]

ARG     RUN_CORE_GENOME_MLST
ENV     RUN_CORE_GENOME_MLST=$RUN_CORE_GENOME_MLST

CMD 	  /usr/local/bin/node /usr/local/mlst/index.js

FROM prod_build as test_build

COPY    tests tests/
RUN     yarn install

ARG     RUN_CORE_GENOME_MLST
RUN     CI=true npm test
