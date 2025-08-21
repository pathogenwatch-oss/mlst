# Dockerfile for building an image for a single scheme. The scheme name is the directory name.
ARG     SCHEME_TAG=2024-08-15-bpseudomallei
ARG     CODE_VERSION=v7.0.0

FROM    registry.gitlab.com/cgps/pathogenwatch/analyses/typing-databases:${SCHEME_TAG} AS scheme

FROM    registry.gitlab.com/cgps/cgps-mlst/mlst-code:${CODE_VERSION} AS indexer

ARG     SCHEME=bpseudomallei
ENV     SCHEME=${SCHEME}

COPY    --from=scheme /db /typing-databases
COPY    --from=scheme /db/schemes.json /typing-databases/schemes.json

RUN     npm run index -- --scheme=${SCHEME} --index=index_dir --database=/typing-databases

FROM    registry.gitlab.com/cgps/cgps-mlst/mlst-code:${CODE_VERSION} AS production

ARG     SCHEME=bpseudomallei
ARG     SANITISER_VERSION=4
ENV     SCHEME=${SCHEME}


RUN     apt update && \
        apt install -y --no-install-recommends curl ca-certificates && \
        rm -rf /var/lib/apt/lists && \
        curl -L -o sanitiser "https://github.com/CorinYeatsCGPS/sanitise-fasta/releases/download/${SANITISER-VERSION}/sanitiser" && \
        chmod +x ./sanitiser && \
        mv sanitiser /usr/local/bin/

COPY    --from=indexer /usr/local/mlst/index_dir /usr/local/mlst/index_dir

RUN     mkdir /mapping_store

COPY    entrypoint.sh /

RUN     chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]