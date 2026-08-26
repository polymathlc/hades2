#!/usr/bin/env bash
# Build + serve + capture the deterministic shot list.
# Usage: tools/run-shots.sh [outdir] [shotIds,comma,sep] [port]
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots/latest}"; ONLY="${2:-}"; PORT="${3:-$((4200 + RANDOM % 500))}"
echo "== building =="
if ! npx vite build --logLevel error; then echo "BUILD FAILED"; exit 3; fi
setsid node tools/serve.mjs dist "$PORT" >/dev/null 2>&1 < /dev/null &
SRV=$!
for i in $(seq 1 40); do
  if curl -sf -o /dev/null "http://localhost:$PORT/"; then break; fi
  sleep 0.25
done
echo "== capturing ($OUT) =="
EREBUS_URL="http://localhost:$PORT/" node tools/shots.mjs "$OUT" "$ONLY"
CODE=$?
kill "$SRV" 2>/dev/null
exit $CODE
