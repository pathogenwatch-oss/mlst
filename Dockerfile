FROM    ubuntu:latest as blast_build

RUN     apt-get update && apt-get install -y wget tar
RUN     wget ftp://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/2.10.0/ncbi-blast-2.10.0+-x64-linux.tar.gz
RUN     tar xzvf ncbi-blast-*-x64-linux.tar.gz
RUN     mv ncbi-blast-*/bin /blast



FROM    node:10-slim as base_build

WORKDIR /usr/local/mlst
COPY    --from=blast_build /blast/blastn /blast/makeblastdb /usr/local/bin/

RUN     apt-get update && apt-get install -y git
COPY    package.json /usr/local/mlst/
RUN     yarn install --production



FROM    base_build as test_build

RUN     yarn install



FROM    node:10-slim as prod_build

WORKDIR /usr/local/mlst
COPY    --from=base_build /usr/local/mlst/node_modules /usr/local/mlst/node_modules
COPY    --from=blast_build /blast/blastn /blast/makeblastdb /usr/local/bin/
COPY    *.js *.json /usr/local/mlst/
COPY    index_dir /usr/local/mlst/index_dir/
COPY    src /usr/local/mlst/src/
SHELL   ["/bin/sh", "-c"]

ARG     RUN_CORE_GENOME_MLST
ENV     RUN_CORE_GENOME_MLST=$RUN_CORE_GENOME_MLST

ENTRYPOINT [ "/usr/local/bin/node", "/usr/local/mlst/index.js" ]
