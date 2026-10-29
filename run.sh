#!/bin/sh
set -e

SRC="${SRC_DIR:-/vault-input}"

# Start background incremental converter and file watcher
node /usr/src/app/convert.mjs --watch "$SRC" /usr/src/app/content &

# Start Quartz static site web server
exec npx quartz build --serve --port=8080 --concurrency=4
