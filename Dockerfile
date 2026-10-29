FROM ghcr.io/jackyzha0/quartz:latest

WORKDIR /usr/src/app

# Pre-install conversion tools during image build (never at container runtime)
RUN npm install --no-save @excalidraw/utils jsdom lz-string chokidar

COPY convert.mjs /usr/src/app/convert.mjs
COPY run.sh /usr/src/app/run.sh
RUN chmod +x /usr/src/app/run.sh

ENTRYPOINT ["/usr/src/app/run.sh"]
