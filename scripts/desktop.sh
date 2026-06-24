#!/usr/bin/env bash
# Launch ClaudeOS as a DESKTOP (Electron) app on macOS.
#
# The file:// renderer can't open terminals on macOS, so this starts the local server
# (where terminals actually work) and opens an Electron window pointed at it via
# COCKPIT_UI_URL. Result: a real desktop window with working live terminals.
#
#   bash scripts/desktop.sh          # uses port 4317
#   COCKPIT_PORT=4317 bash scripts/desktop.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
PORT="${COCKPIT_PORT:-4317}"
mkdir -p "$ROOT/.run"

echo "==> building"
npm run build >/dev/null 2>&1 || { echo "BUILD FAILED"; npm run build 2>&1 | grep -iE 'error' | head; exit 1; }

# Prebuilt node-pty can lose the executable bit on its spawn-helper → terminals fail. Guard it.
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

# Start the server if it isn't already serving.
if ! curl -s -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then
  echo "==> starting server on :${PORT}"
  nohup env COCKPIT_PORT="$PORT" node "$ROOT/dist/server/server.js" >"$ROOT/.run/desktop-server.log" 2>&1 &
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:${PORT}/" 2>/dev/null && break; sleep 0.25; done
fi
curl -s -o /dev/null "http://localhost:${PORT}/" 2>/dev/null || { echo "server did not come up — see $ROOT/.run/desktop-server.log"; exit 1; }

echo "==> opening Electron window → http://localhost:${PORT}/"
COCKPIT_UI_URL="http://localhost:${PORT}/" "$ROOT/node_modules/.bin/electron" --no-sandbox "$ROOT/dist/main/main.js"
