#!/usr/bin/env bash
set -euo pipefail
cd /mnt/d/bbbbb/scripts/tennis-monitor
if [ ! -x venv/bin/python ]; then
  python3 -m venv venv
  ./venv/bin/pip install -q -r requirements.txt
fi
./venv/bin/python -c 'import tm.server; print("import-ok")'
echo "starting monitor_server on :9004 ..."
exec ./venv/bin/python monitor_server.py
