FROM ubuntu as blast_build

RUN apt-get update && apt-get install -y wget tar
RUN wget ftp://ftp.ncbi.nlm.nih.gov/blast/executables/LATEST/ncbi-blast-2.7.1+-x64-linux.tar.gz
RUN tar xzvf ncbi-blast-2.7.1+-x64-linux.tar.gz
RUN mv ncbi-blast-2.7.1+/bin /blast


FROM node:8 as index_build

WORKDIR /usr/local/mlst
COPY    package.json /usr/local/mlst
RUN     npm install --production
COPY    data/cache /opt/mlst/cache
RUN     mkdir -p /usr/local/mlst /opt/mlst/databases && \
        chmod -R a+w /opt/mlst/databases
COPY    *.js *.json /usr/local/mlst/
COPY    src /usr/local/mlst/src/
COPY    schemes /usr/local/mlst/schemes/
SHELL   ["/bin/bash", "-c"]
ARG     RUN_CORE_GENOME_MLST
RUN     DEBUG='*' \
        TYPE=$([[ -z "$RUN_CORE_GENOME_MLST" ]] && echo "mlst" || echo "cgmlst") \
        bash -c 'node ./schemes/index-${TYPE}-databases.js' && \
        chmod -R a+r /opt/mlst/databases


FROM index_build as test_build

COPY    --from=blast_build /blast/blastn /blast/makeblastdb /usr/local/bin/
COPY    tests /usr/local/mlst/tests/
RUN     npm install

ARG     RUN_CORE_GENOME_MLST
RUN     node test
 

FROM node:8

COPY    --from=blast_build /blast/blastn /blast/makeblastdb /usr/local/bin/
COPY    --from=index_build /opt/mlst/databases /opt/mlst/databases
COPY    --from=index_build /usr/local/mlst /usr/local/mlst/

WORKDIR /usr/local/mlst

ARG     RUN_CORE_GENOME_MLST
ENV     RUN_CORE_GENOME_MLST=$RUN_CORE_GENOME_MLST

CMD 	/usr/local/bin/node --max-old-space-size=4096 /usr/local/mlst/index.js
