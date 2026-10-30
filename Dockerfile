# Quartz 5 base image. The registry publishes `latest` only; rebuild to update.
FROM ghcr.io/jackyzha0/quartz:latest

USER root

# tini reaps children and forwards signals to the whole process group.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# The converter has its own locked dependency tree so it cannot disturb the
# Quartz application's node_modules.
WORKDIR /opt/converter
COPY converter/package.json converter/package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY converter/convert.mjs ./

WORKDIR /usr/src/app

# Quartz 5 reads quartz.config.yaml; quartz.ts injects BASE_URL at runtime.
COPY quartz.config.yaml quartz.ts ./
COPY run.sh ./run.sh
RUN chmod +x /usr/src/app/run.sh

# Writable runtime directories, owned by the unprivileged app user. The base
# image ships sample content, so content/ is reset; the build caches are
# recreated empty.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
    && rm -rf \
        /usr/src/app/content \
        /usr/src/app/public \
        /usr/src/app/.quartz-cache \
        /usr/src/app/quartz/.quartz-cache \
    && mkdir -p \
        /usr/src/app/content \
        /usr/src/app/public \
        /usr/src/app/.quartz-cache \
        /usr/src/app/quartz/.quartz-cache \
    && chown -R app:app /usr/src/app

ENV HOME=/tmp \
    NODE_ENV=production

USER app

# The container serves nothing itself; the site is ready once the first build
# has produced an index. The nginx container waits for this to pass.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD test -s /usr/src/app/public/index.html || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/usr/src/app/run.sh"]
