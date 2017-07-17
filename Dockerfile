FROM ubuntu:14.04

RUN apt-get update -qq && \
    apt-get install -y wget ncbi-blast+ && \
    apt-get install -y libmoo-perl liblist-moreutils-perl && \
    apt-get install -y git

RUN wget -O - https://nodejs.org/dist/v6.10.1/node-v6.10.1-linux-x64.tar.gz | \
  tar -xzf - --strip-components=1 -C /usr

RUN git clone https://github.com/tseemann/mlst.git

COPY ./entrypoint.sh /entrypoint.sh
COPY ./parser.js /parser.js
COPY ./node_modules /node_modules

CMD ["/entrypoint.sh"]
