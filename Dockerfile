FROM ubuntu:latest as blast_build

RUN apt-get update && apt-get install -y wget tar
RUN wget ftp://ftp.ncbi.nlm.nih.gov/blast/executables/LATEST/ncbi-blast-2.7.1+-x64-linux.tar.gz
RUN tar xzvf ncbi-blast-2.7.1+-x64-linux.tar.gz
RUN mv ncbi-blast-2.7.1+/bin /blast


FROM node:8 as index_build

WORKDIR /usr/local/mlst
COPY    package.json yarn.lock /usr/local/mlst/
RUN     yarn install --production
COPY    data/cache /opt/mlst/cache
RUN     mkdir -p /usr/local/mlst /opt/mlst/databases && \
        chmod -R a+w /opt/mlst/databases
COPY    *.js *.json /usr/local/mlst/
COPY    src /usr/local/mlst/src/
SHELL   ["/bin/bash", "-c"]
ARG     RUN_CORE_GENOME_MLST
RUN     DEBUG='*' \
        npm run index && \
        chmod -R a+r /opt/mlst/databases


FROM index_build as test_build

COPY    --from=blast_build /blast/blastn /blast/makeblastdb /usr/local/bin/
COPY    tests /usr/local/mlst/tests/
RUN     yarn install

ARG     RUN_CORE_GENOME_MLST
RUN     CI=true npm test
 

FROM node:8

COPY    --from=blast_build /blast/blastn /blast/makeblastdb /usr/local/bin/
COPY    --from=index_build /opt/mlst/databases /opt/mlst/databases
COPY    --from=index_build /usr/local/mlst /usr/local/mlst/

WORKDIR /usr/local/mlst

ARG     RUN_CORE_GENOME_MLST
ENV     RUN_CORE_GENOME_MLST=$RUN_CORE_GENOME_MLST

CMD 	/usr/local/bin/node /usr/local/mlst/index.js
