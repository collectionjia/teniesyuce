#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/yuce/teniesyuce
cd "$ROOT"

echo "==> git pull (sudo)"
sudo git pull --ff-only

echo "==> sync .env from .env.prod for services compose"
sudo cp -a server/.env.prod server/.env
sudo chown root:root server/.env

echo "==> node_modules"
if [[ ! -d server/node_modules ]]; then
  sudo npm install --omit=dev --prefix server
fi

echo "==> redeploy services"
sudo bash scripts/docker-deploy-services.sh up -d --build

echo "==> restart server"
sudo bash scripts/docker-deploy.sh prod up -d server

sleep 20
echo "==> health"
curl -sf http://127.0.0.1:9001/api/health && echo " web ok" || echo " web FAIL"
for p in 9101 9102 9103 9104 9105; do
  curl -sf "http://127.0.0.1:${p}/health" >/dev/null && echo " engine:${p} ok" || echo " engine:${p} FAIL"
done

echo "==> sofa bundle test"
sudo docker exec yuce-prod-server-1 node src/services/tennisSofascore.js --bundle 2>&1 | tail -8

echo "==> inplay API"
curl -s http://127.0.0.1:9001/api/tennis-inplay/today | python3 -c "import sys,json;d=json.load(sys.stdin);print('score_updated_at',d.get('score_updated_at'),'events',d.get('events'))"

echo "==> done"
