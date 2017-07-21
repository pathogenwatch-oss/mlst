FROM biocontainers/blast

USER root
RUN apt-get update && apt-get install -y wget tar
RUN cd /tmp && wget https://nodejs.org/dist/v6.11.1/node-v6.11.1-linux-x64.tar.xz
RUN mkdir -p /usr/local && cd /usr/local && tar -xf /tmp/node-v6.11.1-linux-x64.tar.xz && \
    ln -s /usr/local/node-v6.11.1-linux-x64/bin/node /usr/local/bin && \
    ln -s /usr/local/node-v6.11.1-linux-x64/bin/npm /usr/local/bin

USER biodocker
