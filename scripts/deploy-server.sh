#!/bin/bash
set -e
cd /opt/yuce/bbbbb
sudo mkdir -p /tmp/yuce-deploy/client/src/components /tmp/yuce-deploy/client/src/utils \
  /tmp/yuce-deploy/server/src/routes /tmp/yuce-deploy/server/src/services /tmp/yuce-deploy/server/scripts \
  client/src/components client/src/utils server/src/routes server/src/services server/scripts

# client
sudo cp /tmp/yuce-deploy/client/src/App.vue client/src/
sudo cp /tmp/yuce-deploy/client/src/api.js client/src/
sudo cp /tmp/yuce-deploy/client/src/productIcons.js client/src/
sudo cp /tmp/yuce-deploy/client/src/components/TennisBoard.vue client/src/components/
sudo cp /tmp/yuce-deploy/client/src/components/TennisLiveMonitor.vue client/src/components/
sudo cp /tmp/yuce-deploy/client/src/components/LiveTop100Scraper.vue client/src/components/
sudo cp /tmp/yuce-deploy/client/src/utils/tennisLiveFilter.js client/src/utils/
sudo cp /tmp/yuce-deploy/client/src/utils/sofaMatchUrl.js client/src/utils/

# server
sudo cp /tmp/yuce-deploy/server/src/index.js server/src/
sudo cp /tmp/yuce-deploy/server/src/routes/sofaMonitor.js server/src/routes/
sudo cp /tmp/yuce-deploy/server/src/routes/tennisLive.js server/src/routes/
sudo cp /tmp/yuce-deploy/server/src/routes/tennisLiveMonitor.js server/src/routes/
sudo cp /tmp/yuce-deploy/server/src/routes/tennisLiveScraper.js server/src/routes/
sudo cp /tmp/yuce-deploy/server/src/routes/admin.js server/src/routes/
sudo cp /tmp/yuce-deploy/server/src/services/tennisFromMonitor.js server/src/services/
sudo cp /tmp/yuce-deploy/server/src/services/tennisLiveFilter.js server/src/services/
sudo cp /tmp/yuce-deploy/server/src/services/tennisLiveFromMonitor.js server/src/services/
sudo cp /tmp/yuce-deploy/server/src/services/tennisLiveCache.js server/src/services/
sudo cp /tmp/yuce-deploy/server/src/services/tennisTrade.js server/src/services/
sudo cp /tmp/yuce-deploy/server/src/services/tradeRecords.js server/src/services/
sudo cp /tmp/yuce-deploy/server/src/services/tennisPolymarketMatch.js server/src/services/
sudo cp /tmp/yuce-deploy/server/src/services/sofaMonitorTop100.js server/src/services/
sudo cp /tmp/yuce-deploy/server/scripts/upsert-tennis-live-product.js server/scripts/

sudo rsync -a /tmp/sofascore-monitor-new/ scripts/sofascore-monitor/
if [ -f /tmp/yuce-deploy/docker-compose.core.yml ]; then
  sudo cp /tmp/yuce-deploy/docker-compose.core.yml ./
fi

echo "=== build web server ==="
sudo docker compose -f docker-compose.core.yml build web server

echo "=== up web server ==="
sudo docker compose -f docker-compose.core.yml up -d web server

echo "=== upsert tennis-live product ==="
sudo docker compose -f docker-compose.core.yml exec -T server node scripts/upsert-tennis-live-product.js

echo "=== restart monitor ==="
sudo systemctl restart sofascore-monitor
sleep 4
systemctl is-active sofascore-monitor

echo "=== warm live cache ==="
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisLiveFromMonitor").refreshLiveBundleFromMonitor().then(function(b){console.log("live",b.events,b.message)}).catch(function(e){console.error(e.message);process.exit(1)})'

echo "=== verify ==="
curl -s http://127.0.0.1:8890/api/state | python3 -c "import sys,json;d=json.load(sys.stdin);lb=d.get('leaderboard')or{};print('board up/dn',lb.get('up_count'),lb.get('dn_count'))"
curl -s http://127.0.0.1:9004/health
echo
sudo docker compose -f docker-compose.core.yml ps
