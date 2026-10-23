#!/usr/bin/env bash
# Applies database migrations to the database in backend/.env (DATABASE_URL),
# or to the URL given as the first argument. Migrations only add or alter
# schema; they never drop your data.
#   ./scripts/migrate.sh
#   ./scripts/migrate.sh "postgresql://...production pooler url..."
set -euo pipefail
cd "$(dirname "$0")/../backend"
if [ "${1:-}" != "" ]; then export DATABASE_URL="$1"; fi
./.venv/bin/python -m alembic upgrade head
./.venv/bin/python -m alembic current
