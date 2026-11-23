#!/usr/bin/env bash
# One-command start:  ./run.sh   (creates a virtualenv, builds the data on first run, starts the app on :8000)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
if [ ! -f data/nepd.db ] || [ "${REBUILD:-0}" = "1" ]; then
  .venv/bin/python -m server.build
fi
echo "NE Pharma Supply Planner → http://localhost:${PORT}"
exec .venv/bin/uvicorn server.api:app --host 0.0.0.0 --port "${PORT}"
