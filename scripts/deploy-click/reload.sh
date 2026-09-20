#!/bin/bash
set -euo pipefail
mv /tmp/deploy-click-app.py /opt/yuce/deploy-click/app.py
chown ubuntu:ubuntu /opt/yuce/deploy-click/app.py
systemctl restart deploy-click.service
sleep 1
systemctl is-active deploy-click.service
TOKEN=$(cat /opt/yuce/deploy-click/token)
curl -sf -o /dev/null -w "http:%{http_code}\n" "http://127.0.0.1:9009/?token=${TOKEN}"
curl -sf -X POST "http://127.0.0.1:9009/api/shell?token=${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"pwd"}'
sleep 1
curl -sf "http://127.0.0.1:9009/api/shell/logs?token=${TOKEN}" > /tmp/shell-logs.json
python3 - <<'PY'
import json
d = json.load(open("/tmp/shell-logs.json"))
print("".join(d.get("lines") or [])[-400:])
print("cwd", d.get("cwd"))
print("running", d.get("running"))
PY
echo "URL=http://95.40.57.145:9009/?token=${TOKEN}"
