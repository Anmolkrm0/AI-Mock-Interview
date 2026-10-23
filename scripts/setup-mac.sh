#!/usr/bin/env bash
# One-time setup on macOS (Apple Silicon or Intel). Safe to re-run.
#   ./scripts/setup-mac.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

say "1/6 Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Install it from https://brew.sh, then re-run this script."
  exit 1
fi

say "2/6 Installing Python 3.12, Node 22 and PostgreSQL 16 (for tests) if missing"
brew list python@3.12 >/dev/null 2>&1 || brew install python@3.12
brew list node@22 >/dev/null 2>&1 || brew install node@22
brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
PY="$(brew --prefix python@3.12)/bin/python3.12"
export PATH="$(brew --prefix node@22)/bin:$(brew --prefix postgresql@16)/bin:$PATH"
echo "Python: $($PY --version)  Node: $(node --version)  npm: $(npm --version)"

say "3/6 Backend virtual environment and dependencies"
cd "$ROOT/backend"
[ -d .venv ] || "$PY" -m venv .venv
./.venv/bin/pip install --upgrade pip >/dev/null
./.venv/bin/pip install -r requirements-dev.txt
[ -f .env ] || { cp .env.example .env; echo "Created backend/.env from the example. Fill in your keys."; }

say "4/6 Frontend dependencies (creates package-lock.json; commit it, Render's npm ci needs it)"
cd "$ROOT/frontend"
npm install
[ -f .env.local ] || { cp .env.example .env.local; echo "Created frontend/.env.local from the example. Fill in your keys."; }
npx playwright install chromium >/dev/null 2>&1 || echo "(Playwright browser install skipped; run 'npx playwright install chromium' before E2E tests.)"

say "5/6 Local PostgreSQL for the automated tests"
brew services start postgresql@16 >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do pg_isready -q -h 127.0.0.1 && break; sleep 1; done
pg_isready -h 127.0.0.1 || echo "PostgreSQL isn't running; tests that need a database will fail until it is."

say "6/6 Done"
cat <<MSG
Next:
  1. Fill in backend/.env and frontend/.env.local (see README, "Configure").
  2. Apply the database schema to Supabase:   ./scripts/migrate.sh
  3. Verify everything builds and passes:      ./scripts/verify.sh
  4. Run the app:                              ./scripts/dev.sh   then open http://localhost:3000
MSG
