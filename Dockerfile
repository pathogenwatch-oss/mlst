FROM sangerpathogens/mlst_check

RUN wget -O - https://nodejs.org/dist/v6.10.1/node-v6.10.1-linux-x64.tar.gz | \
  tar -xzf - --strip-components=1 -C /usr

COPY ./entypoint.sh /entypoint.sh
COPY ./parser.js /parser.js

VOLUME /data

CMD ["/entypoint.sh"]
