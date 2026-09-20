#!/bin/sh
set -e
mkdir -p /app/data
if [ ! -f /app/data/dota2elo.db ] && [ -f /app/data-seed/dota2elo.db ]; then
  echo "[dota2elo] seeding SQLite from image..."
  cp /app/data-seed/dota2elo.db /app/data/dota2elo.db
fi
if [ ! -f /app/data/calibration.json ] && [ -f /app/data-seed/calibration.json ]; then
  cp /app/data-seed/calibration.json /app/data/calibration.json
fi
exec "$@"
