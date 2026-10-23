#!/usr/bin/env bash
# Starts the backend (port 8000) and frontend (port 3000) together. Ctrl+C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v brew >/dev/null 2>&1; then export PATH="$(brew --prefix node@22 2>/dev/null)/bin:$PATH"; fi
trap 'kill 0' EXIT
( cd "$ROOT/backend" && ./.venv/bin/uvicorn app.main:app --reload --port 8000 ) &
( cd "$ROOT/frontend" && npm run dev ) &
wait
