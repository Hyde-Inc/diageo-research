#!/usr/bin/env bash
# Demo smoke — hero seed + core routes + SSE open/close.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${MBP_API:-http://127.0.0.1:8765}"
FE="${MBP_FE:-http://127.0.0.1:3011}"

cd "$ROOT"

echo "==> Seeding hero study (if API up)"
if curl -sf "$API/studies" >/dev/null 2>&1; then
  uv run python scripts/seed_hero_study.py || true
else
  echo "WARN: API not reachable at $API — skipping seed"
fi

HERO="study_31c6667a40"

check_route() {
  local path="$1"
  local code
  code="$(curl -so /dev/null -w '%{http_code}' "$FE$path" || true)"
  if [[ "$code" != "200" ]]; then
    echo "FAIL $path → HTTP $code"
    exit 1
  fi
  echo "PASS $path"
}

echo "==> FE routes"
check_route "/"
check_route "/research?study=$HERO"
check_route "/growth-driver?study=$HERO"
check_route "/evidence?study=$HERO"
check_route "/simulation?study=$HERO"

echo "==> API research findings payload"
if curl -sf "$API/studies/$HERO/research" | grep -q '"findings"'; then
  echo "PASS GET /studies/$HERO/research findings[]"
else
  echo "FAIL research payload missing findings"
  exit 1
fi

echo "==> SSE handshake (5s)"
if curl -sf "$API/studies" >/dev/null 2>&1; then
  timeout 5 curl -sN -H 'Accept: text/event-stream' \
    "$API/studies/$HERO/stream" >/dev/null && echo "PASS SSE stream opened" || {
    echo "FAIL SSE stream"
    exit 1
  }
else
  echo "SKIP SSE — API down"
fi

echo "All demo smoke checks passed."
