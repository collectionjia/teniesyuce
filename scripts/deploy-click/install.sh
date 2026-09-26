#!/bin/bash
set -euo pipefail
mkdir -p /opt/yuce/deploy-click
mv /tmp/deploy-click-app.py /opt/yuce/deploy-click/app.py
chown ubuntu:ubuntu /opt/yuce/deploy-click/app.py
if [[ ! -s /opt/yuce/deploy-click/token ]]; then
  python3 - <<'PY'
import secrets
from pathlib import Path
Path("/opt/yuce/deploy-click/token").write_text(secrets.token_urlsafe(18))
PY
  chmod 600 /opt/yuce/deploy-click/token
  chown ubuntu:ubuntu /opt/yuce/deploy-click/token
fi
cat >/etc/systemd/system/deploy-click.service <<'EOF'
[Unit]
Description=One-click deploy page
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/opt/yuce/deploy-click
Environment=DEPLOY_ROOT=/opt/yuce/teniesyuce
Environment=DEPLOY_SCRIPT=/opt/yuce/teniesyuce/scripts/deploy-145.sh
ExecStart=/usr/bin/python3 /opt/yuce/deploy-click/app.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now deploy-click.service
sleep 1
systemctl is-active deploy-click.service
TOKEN=$(cat /opt/yuce/deploy-click/token)
curl -sf -o /dev/null -w "local:%{http_code}\n" "http://127.0.0.1:9009/?token=${TOKEN}"
echo "URL=http://95.40.57.145:9009/?token=${TOKEN}"
