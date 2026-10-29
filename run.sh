#!/bin/sh
set -eu

SRC="${SRC_DIR:-/vault-input}"
DEST="${DEST_DIR:-/usr/src/app/content}"
CONVERTER="/opt/converter/convert.mjs"

# Keep the cache manifest outside the published content tree. It is
# intentionally ephemeral: losing it only causes a full re-render on restart.
export STATE_FILE="${STATE_FILE:-/tmp/excalidraw-publisher-state.json}"

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
