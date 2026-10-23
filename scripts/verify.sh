#!/usr/bin/env bash
# Runs every automated check: lint, types, unit + integration tests, production build.
#   ./scripts/verify.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v brew >/dev/null 2>&1; then
  export PATH="$(brew --prefix node@22 2>/dev/null)/bin:$(brew --prefix postgresql@16 2>/dev/null)/bin:$PATH"
fi
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://$(whoami)@127.0.0.1:5432/mock_interview_test}"
failures=()
run() {
  local name="$1"; shift
  printf "\n\033[1m▶ %s\033[0m\n" "$name"
  if "$@"; then printf "\033[32m✓ %s\033[0m\n" "$name"; else printf "\033[31m✗ %s\033[0m\n" "$name"; failures+=("$name"); fi
}

cd "$ROOT/backend"
run "Backend lint (ruff)" ./.venv/bin/ruff check .
run "Backend format check" ./.venv/bin/ruff format --check .
run "Backend tests (pytest, real Postgres, AI mocked)" ./.venv/bin/python -m pytest -q

cd "$ROOT/frontend"
run "Frontend type check" npm run typecheck
run "Frontend lint" npm run lint
run "Frontend unit tests (vitest)" npm test
run "Frontend production build" env NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-https://placeholder.supabase.co}" \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:-placeholder}" \
  NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:8000}" npm run build

echo
if [ ${#failures[@]} -eq 0 ]; then
  echo "All checks passed."
else
  echo "Failed: ${failures[*]}"
  exit 1
fi
