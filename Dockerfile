FROM ubuntu:14.04

RUN apt-get update -qq && \
    apt-get install -y wget ncbi-blast+ && \
    apt-get install -y libmoo-perl liblist-moreutils-perl && \
    apt-get install -y git

RUN git clone https://github.com/tseemann/mlst.git

COPY ./entrypoint.sh /entrypoint.sh
COPY ./parser.py /parser.py
COPY ./taxIdSchemeMap.csv /taxIdSchemeMap.csv

CMD ["/entrypoint.sh"]
