#!/bin/bash
set -e
cd /opt/yuce
sudo docker compose -f docker-compose.core.yml build server
sudo docker compose -f docker-compose.core.yml up -d server
sleep 3
# 发版不自�?upsert 产品（见 server/scripts/upsert-tennis-*-product.js�?
sudo docker compose -f docker-compose.core.yml exec -T server node scripts/warm-live-cache.js 2>/dev/null || \
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisLiveFromMonitor").refreshLiveBundleFromMonitor().then(function(b){console.log("live ok", b.events, (b.live||{}).eventCount)}).catch(function(e){console.error(e.message);process.exit(1)})'
curl -s http://127.0.0.1:9004/health
echo
sudo docker compose -f docker-compose.core.yml ps
