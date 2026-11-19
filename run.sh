#!/bin/sh
set -eu

SRC="${SRC_DIR:-/vault-input}"
DEST="${DEST_DIR:-/usr/src/app/content}"
SUPERVISOR="/opt/converter/supervisor.mjs"

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
# Quartz wipes its output directory on every build, and a bind mountpoint cannot
# be removed (EBUSY), so build into a subdirectory of the mount instead.
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

exec node "$SUPERVISOR" "$SRC" "$DEST" "$PUBLIC/site"
