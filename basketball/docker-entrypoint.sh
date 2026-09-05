#!/bin/sh
set -e
mkdir -p /app/data
exec python -m uvicorn app.api:app --host 0.0.0.0 --port "${PORT:-8780}"
