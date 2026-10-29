#!/bin/sh
set -eu

SRC="${SRC_DIR:-/vault-input}"
DEST="${DEST_DIR:-/usr/src/app/content}"
CONVERTER="/opt/converter/convert.mjs"

# Cache manifest stored in the content directory so it persists across restarts.
# Quartz automatically ignores .converter-state.json.
export STATE_FILE="${STATE_FILE:-$DEST/.converter-state.json}"

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
# Invoke the bundled CLI directly instead of `npx` so the container never
# touches npm's resolution/cache paths (the root filesystem is read-only).
node /usr/src/app/quartz/bootstrap-cli.mjs build --serve --port=8080 --concurrency=4 &
QUARTZ_PID=$!
wait "$QUARTZ_PID"
