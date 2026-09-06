#!/bin/bash
set -e
cd /opt/yuce/bbbbb/scripts/sofascore-monitor
./venv/bin/python -m py_compile enrich.py bundle.py bundle_enrich.py top20_collector.py monitor_server.py
sudo systemctl restart sofascore-monitor
sleep 2
curl -s -X POST -H 'Authorization: Bearer sofascore-monitor-2026' http://127.0.0.1:9004/collect
echo
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  sleep 10
  st=$(curl -s -H 'Authorization: Bearer sofascore-monitor-2026' http://127.0.0.1:9004/status)
  running=$(echo "$st" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("running"))')
  echo "poll $i running=$running"
  if [ "$running" = "False" ]; then break; fi
done
curl -s -H 'Authorization: Bearer sofascore-monitor-2026' http://127.0.0.1:9004/status | python3 -c 'import sys,json; d=json.load(sys.stdin); b=d.get("latest_bundle") or {}; lr=d.get("last_run") or {}; print("last", lr.get("status"), lr.get("error")); print("bundle", b)'
sudo cp /tmp/tennisFromMonitor.js /opt/yuce/bbbbb/server/src/services/tennisFromMonitor.js
docker cp /opt/yuce/bbbbb/server/src/services/tennisFromMonitor.js bbbbb-server-1:/app/src/services/tennisFromMonitor.js
cd /opt/yuce/bbbbb
docker compose -f docker-compose.core.yml restart server
sleep 4
docker exec bbbbb-server-1 node /app/refresh_tennis_redis.js
