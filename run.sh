#!/bin/sh
set -eu

SRC="${SRC_DIR:-/vault-input}"
DEST="${DEST_DIR:-/usr/src/app/content}"
CONVERTER="/opt/converter/convert.mjs"

# Cache manifest stored in the content directory so it persists across restarts.
# Quartz automatically ignores .converter-state.json.
export STATE_FILE="${STATE_FILE:-$DEST/.converter-state.json}"

# Check permissions of the quartz-content directory
if ! touch "$DEST/.perm_check" 2>/dev/null; then
  echo "" >&2
  echo "========================================================================" >&2
  echo "[ERROR] Cannot write to '$DEST' (quartz-content)!" >&2
  echo "The container runs as an unprivileged user (UID 10001)." >&2
  echo "Please set the correct ownership on your host by running:" >&2
  echo "" >&2
  echo "    sudo chown -R 10001:10001 ./quartz-content" >&2
  echo "========================================================================" >&2
  echo "" >&2
  exit 1
fi
rm -f "$DEST/.perm_check"

# The rendered site is a host bind mount too, shared with the web container.
PUBLIC="${PUBLIC_DIR:-/usr/src/app/public}"
if ! touch "$PUBLIC/.perm_check" 2>/dev/null; then
  echo "" >&2
  echo "========================================================================" >&2
  echo "[ERROR] Cannot write to '$PUBLIC' (public)!" >&2
  echo "The container runs as an unprivileged user (UID 10001)." >&2
  echo "Please set the correct ownership on your host by running:" >&2
  echo "" >&2
  echo "    sudo chown -R 10001:10001 ./public" >&2
  echo "========================================================================" >&2
  echo "" >&2
  exit 1
fi
rm -f "$PUBLIC/.perm_check"

# Check that the source vault is readable
if [ ! -d "$SRC" ] || [ ! -r "$SRC" ]; then
  echo "" >&2
  echo "========================================================================" >&2
  echo "[ERROR] Cannot read source directory '$SRC'!" >&2
  echo "Please verify the vault volume mount in docker-compose.yaml." >&2
  echo "========================================================================" >&2
  echo "" >&2
  exit 1
fi

echo "[run] Running initial conversion sweep..."
node "$CONVERTER" --sweep "$SRC" "$DEST"

echo "[run] Starting converter supervisor..."
(
  trap 'exit 0' TERM INT
  while true; do
    node "$CONVERTER" --watch "$SRC" "$DEST" &
    CHILD_PID=$!
    wait "$CHILD_PID" || true
    echo "[run] Converter exited; restarting in 2s..." >&2
    sleep 2
  done
) &
SUPERVISOR_PID=$!

cleanup() {
  kill "$SUPERVISOR_PID" 2>/dev/null || true
  if [ -n "${QUARTZ_PID:-}" ]; then
    kill "$QUARTZ_PID" 2>/dev/null || true
  fi
}
trap cleanup TERM INT EXIT

# Start Quartz only after the synchronous sweep has populated content/.
# Watch mode rebuilds public/ on changes; it never opens a port, the nginx
# container serves the output. Invoke the bundled CLI directly instead of
# `npx` so the container never touches npm's resolution/cache paths.
node /usr/src/app/quartz/bootstrap-cli.mjs build --watch --concurrency=4 &
QUARTZ_PID=$!
wait "$QUARTZ_PID"
