#!/usr/bin/env bash
# The showcase screenshots (docs/SCREENSHOTS.md), end to end: a development web export with the test store, a local game
# server on a fresh Postgres database with sample data, both showcase accounts, every capture, then the frames.
#   PGURL=postgres://postgres@localhost:5432 apps/mobile/e2e/showcase/showcase.sh [outdir]
# PGURL: a Postgres server this script may create and drop the database mjm_showcase on (never a real one).
# NOTO_CSS (optional): Noto Sans TC's stylesheet for the Chinese headlines (npm pack @fontsource/noto-sans-tc; 900.css).
# DEAL (optional): the deal seed (default 3: the player wins a 5-台 concealed self-draw); find-deal.cjs looks for others.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MOBILE="$(cd "$HERE/../.." && pwd)"
SIGNAL="$(cd "$MOBILE/../signal" && pwd)"
OUT="$(mkdir -p "${1:-${TMPDIR:-/tmp}/mjm-showcase}" && cd "${1:-${TMPDIR:-/tmp}/mjm-showcase}" && pwd)"
: "${PGURL:?set PGURL to a Postgres server URL without a database name}"
DB="$PGURL/mjm_showcase"
DEAL="${DEAL:-3}"

if curl -s -m 2 localhost:8787/health > /dev/null 2>&1; then
  echo "Something already answers on localhost:8787; stop it first (the export talks to the server there)." >&2
  exit 1
fi

echo "== web export (development build, test store)"
if [ ! -f "$OUT/web/index.html" ]; then
  (cd "$MOBILE" && env -u SIGNAL_URL CI=1 EXPO_PUBLIC_STORE_MODE=mock npx expo export --platform web --dev --output-dir "$OUT/web" > "$OUT/export.log" 2>&1)
fi

echo "== database mjm_showcase"
psql "$PGURL/postgres" -q -c "DROP DATABASE IF EXISTS mjm_showcase" -c "CREATE DATABASE mjm_showcase"

PEPPER="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
SERVER_PID=""
start_server() {
  # Its own process group, so stopping it stops npx and the server under it, and nothing else on the machine.
  setsid env PORT=8787 DATABASE_URL="$DB" MIGRATE_ON_BOOT=1 AUTH_PEPPER="$PEPPER" CORS_ORIGINS='*' NODE_ENV=development \
    bash -c "cd '$SIGNAL' && exec npx tsx src/main.ts" >> "$OUT/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do curl -s -m 2 localhost:8787/health > /dev/null 2>&1 && return 0; sleep 1; done
  echo "the game server did not start; see $OUT/server.log" >&2
  exit 1
}
stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill -- "-$SERVER_PID" 2> /dev/null || true
    wait "$SERVER_PID" 2> /dev/null || true
    SERVER_PID=""
  fi
  for _ in $(seq 1 20); do curl -s -m 1 localhost:8787/health > /dev/null 2>&1 || return 0; sleep 0.5; done
}
trap stop_server EXIT

echo "== accounts and sample data"
start_server
node "$HERE/boot.cjs" "$OUT/web" "$OUT/state-en.json" "Mei-Ling" lady en-US
node "$HERE/boot.cjs" "$OUT/web" "$OUT/state-zh.json" "美玲" lady zh-TW
node "$HERE/seed.cjs" "$OUT/state-en.json" "$OUT/state-zh.json" clubs
stop_server
DATABASE_URL="$DB" node "$HERE/seed.cjs" "$OUT/state-en.json" "$OUT/state-zh.json" data
start_server

echo "== captures"
node "$HERE/capture.cjs" "$OUT/web" "$OUT/shots" "$OUT/state-en.json" en phone "$DEAL"
node "$HERE/capture.cjs" "$OUT/web" "$OUT/shots" "$OUT/state-zh.json" zh phone "$DEAL"
node "$HERE/capture.cjs" "$OUT/web" "$OUT/shots" "$OUT/state-en.json" en tablet "$DEAL" only=table,learn,shop
node "$HERE/capture.cjs" "$OUT/web" "$OUT/shots" "$OUT/state-zh.json" zh tablet "$DEAL" only=table,learn,shop
stop_server

echo "== frames"
node "$HERE/frame.cjs" "$HERE/frames.json" "$OUT/shots" "$OUT/framed" "$OUT/web"
echo "Done: $OUT/shots (every capture) and $OUT/framed (the store-style set)."
