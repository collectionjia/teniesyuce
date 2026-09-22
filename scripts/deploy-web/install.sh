#!/bin/bash
# 在服务器上执行：bash /opt/yucebid/scripts/deploy-web/install.sh
set -euo pipefail
ROOT="${DEPLOY_ROOT:-/opt/yucebid}"
TOKEN_FILE="$ROOT/.deploy-web-token"
APP="$ROOT/scripts/deploy-web/app.py"

test -f "$APP"
if [[ ! -s "$TOKEN_FILE" ]]; then
  python3 - <<PY
import secrets
from pathlib import Path
Path("$TOKEN_FILE").write_text(secrets.token_urlsafe(18))
PY
  chmod 600 "$TOKEN_FILE"
fi

cat >/etc/systemd/system/yucebid-deploy-web.service <<EOF
[Unit]
Description=yucebid one-click deploy page
After=network.target

[Service]
WorkingDirectory=$ROOT
Environment=DEPLOY_ROOT=$ROOT
Environment=DEPLOY_PORT=9102
Environment=DEPLOY_TOKEN_FILE=$TOKEN_FILE
ExecStart=/usr/bin/python3 $APP
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now yucebid-deploy-web.service
sleep 1
systemctl is-active yucebid-deploy-web.service
TOKEN=$(cat "$TOKEN_FILE")
curl -sf -o /dev/null -w "local:%{http_code}\n" "http://127.0.0.1:9102/?token=${TOKEN}"
echo "URL=http://46.250.163.215:9102/?token=${TOKEN}"
