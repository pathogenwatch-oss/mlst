# Dockerfile for building an image for a single scheme. The scheme name is the directory name.
ARG     CODE_VERSION=v8.0.0
ARG     SANITISER_VERSION=4
ARG     SCHEME_TAG=2025-09-01-efaecium
ARG     SCHEME=efaecium

# Base production image with sanitiser (cacheable)
FROM    registry.gitlab.com/cgps/cgps-mlst/mlst-code:${CODE_VERSION} AS base-production

ARG     SANITISER_VERSION
RUN     echo "Downloading sanitiser version ${SANITISER_VERSION}" && \
        apt update && \
        apt install -y --no-install-recommends curl ca-certificates && \
        rm -rf /var/lib/apt/lists/* && \
        curl -L -o sanitiser "https://github.com/CorinYeatsCGPS/sanitise-fasta/releases/download/${SANITISER_VERSION}/sanitiser" && \
        chmod +x ./sanitiser && \
        mv sanitiser /usr/local/bin/

FROM    registry.gitlab.com/cgps/pathogenwatch/analyses/typing-databases:${SCHEME_TAG} AS scheme

FROM    base-production AS indexer
ARG     SCHEME
ENV     SCHEME=${SCHEME}
COPY    --from=scheme /db /typing-databases
COPY    --from=scheme /selected_schemes.json /typing-databases/schemes.json
RUN     npm run index -- --scheme=${SCHEME} --index=index_dir --database=/typing-databases

FROM    base-production AS production
ARG     SCHEME
ENV     SCHEME=${SCHEME}
COPY    --from=indexer /usr/local/mlst/index_dir /usr/local/mlst/index_dir
RUN     mkdir /mapping_store
COPY    entrypoint.sh /
RUN     chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]