#!/bin/bash
set -e
cd /opt/yuce
python3 <<'PY'
from pathlib import Path
p = Path("docker-compose.core.yml")
text = p.read_text(encoding="utf-8")
text = text.replace("${REDIS_PORT:-9003}:6379", "127.0.0.1:9014:6379")
text = text.replace("127.0.0.1:16379:6379", "127.0.0.1:9014:6379")
p.write_text(text, encoding="utf-8")
print("patched redis port -> 127.0.0.1:9014")
PY
sudo docker rm -f yuce-redis-1 yuce-server-1 yuce-web-1 2>/dev/null || true
sudo docker compose -f docker-compose.core.yml up -d
# 产品注册请手动执�?upsert-tennis-*-product.js
sudo systemctl restart tennis-monitor
sleep 4
curl -sf -X POST http://127.0.0.1:9004/schedule \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sofascore-monitor-2026' \
  -d '{"interval_hours":4}' || true
sudo docker compose -f docker-compose.core.yml exec -T server node -e \
  'require("./src/services/tennisNewFromMonitor").refreshNewBundleFromMonitor().then(b=>console.log("new",b.events)).catch(e=>{console.error(e.message);process.exit(1)})'
curl -sf http://127.0.0.1:9004/health && echo
sudo docker compose -f docker-compose.core.yml ps
