#!/usr/bin/env bash
# Build + serve + capture the deterministic shot list.
# Usage: tools/run-shots.sh [outdir] [shotIds,comma,sep] [port]
# Concurrency-safe: each invocation builds into its own dist dir and serves on its own port.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots/latest}"; ONLY="${2:-}"; PORT="${3:-$((4200 + RANDOM % 600))}"
DIST=".dist-$PORT"
echo "== building -> $DIST =="
if ! npx vite build --logLevel error --outDir "$DIST" --emptyOutDir; then echo "BUILD FAILED"; exit 3; fi
setsid node tools/serve.mjs "$DIST" "$PORT" >/dev/null 2>&1 < /dev/null &
SRV=$!
for i in $(seq 1 60); do curl -sf -o /dev/null "http://localhost:$PORT/" && break; sleep 0.25; done
echo "== capturing -> $OUT =="
EREBUS_URL="http://localhost:$PORT/" node tools/shots.mjs "$OUT" "$ONLY"
CODE=$?
kill "$SRV" 2>/dev/null
rm -rf "$DIST"
exit $CODE
