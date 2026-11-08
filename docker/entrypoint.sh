#!/bin/sh
# First start: create the database with the DEV dialogs and ready-made evaluations (no model calls).
set -e
DB="${CQA_DB:-/app/state/cqa.sqlite}"
mkdir -p "$(dirname "$DB")" /app/runs/cache
if [ ! -f "$DB" ]; then
  echo "cqa: seeding $DB"
  python -m cqa.seed --db "$DB"
fi
exec python -m uvicorn cqa.api:app --host 0.0.0.0 --port "${PORT:-8030}"
