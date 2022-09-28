ARG     DATA_NAME
ARG     DATA_VERSION
ARG     CODE_VERSION

FROM    registry.gitlab.com/cgps/cgps-mlst/${DATA_NAME}-data:${DATA_VERSION} as data

FROM    registry.gitlab.com/cgps/cgps-mlst/mlst-code:${CODE_VERSION} as production

COPY    --from=data /usr/local/mlst/index_dir /usr/local/mlst/index_dir

ARG     RUN_CORE_GENOME_MLST
ENV     RUN_CORE_GENOME_MLST=$RUN_CORE_GENOME_MLST

ENTRYPOINT [ "/usr/local/bin/node", "/usr/local/mlst/index.js" ]
