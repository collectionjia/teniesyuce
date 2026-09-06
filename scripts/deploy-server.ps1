# 部署 web + server + sofascore-monitor 到生产
# 用法: powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Key = if ($env:DEV_SSH_KEY) { $env:DEV_SSH_KEY } else { Join-Path $env:USERPROFILE 'Desktop\LightsailDefaultKey-ap-east-1 (2).pem' }
if (-not (Test-Path $Key)) { $Key = Join-Path $env:USERPROFILE '.ssh\lightsail-ap-east-1.pem' }
$HostName = if ($env:DEV_SSH_HOST) { $env:DEV_SSH_HOST } else { 'ubuntu@95.40.57.145' }

if (-not (Test-Path $Key)) { throw "SSH key missing: $Key" }

$DeployDir = Join-Path $Root 'tmp-deploy'
$MonitorDir = Join-Path $DeployDir 'sofascore-monitor'
Remove-Item $DeployDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'client/src/components') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'client/src/utils') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'server/src/routes') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'server/src/services') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'server/scripts') | Out-Null

Copy-Item "$Root\client\src\App.vue" "$DeployDir\client\src\"
Copy-Item "$Root\client\src\api.js" "$DeployDir\client\src\"
Copy-Item "$Root\client\src\productIcons.js" "$DeployDir\client\src\"
Copy-Item "$Root\client\src\components\TennisBoard.vue" "$DeployDir\client\src\components\"
Copy-Item "$Root\client\src\components\TennisLiveMonitor.vue" "$DeployDir\client\src\components\"
Copy-Item "$Root\client\src\components\LiveTop100Scraper.vue" "$DeployDir\client\src\components\"
Copy-Item "$Root\client\src\components\SofaMonitor.vue" "$DeployDir\client\src\components\"
Copy-Item "$Root\client\src\utils\tennisLiveFilter.js" "$DeployDir\client\src\utils\"
Copy-Item "$Root\client\src\utils\tennisRangeFilter.js" "$DeployDir\client\src\utils\"
Copy-Item "$Root\client\src\utils\sofaMatchUrl.js" "$DeployDir\client\src\utils\"

Copy-Item "$Root\server\src\index.js" "$DeployDir\server\src\"
Copy-Item "$Root\server\src\routes\sofaMonitor.js" "$DeployDir\server\src\routes\"
Copy-Item "$Root\server\src\routes\tennisLive.js" "$DeployDir\server\src\routes\"
Copy-Item "$Root\server\src\routes\tennisLiveMonitor.js" "$DeployDir\server\src\routes\"
Copy-Item "$Root\server\src\routes\tennisLiveScraper.js" "$DeployDir\server\src\routes\"
Copy-Item "$Root\server\src\routes\tennisNew.js" "$DeployDir\server\src\routes\"
Copy-Item "$Root\server\src\routes\admin.js" "$DeployDir\server\src\routes\"
Copy-Item "$Root\server\src\services\tennisFromMonitor.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisLiveFilter.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisLiveFromMonitor.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisLiveCache.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisNewCache.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisNewFromMonitor.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisRangeFilter.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisRangeFromMonitor.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisTrade.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tradeRecords.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\tennisPolymarketMatch.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\src\services\sofaMonitorTop100.js" "$DeployDir\server\src\services\"
Copy-Item "$Root\server\scripts\upsert-tennis-live-product.js" "$DeployDir\server\scripts\"
Copy-Item "$Root\server\scripts\upsert-tennis-new-product.js" "$DeployDir\server\scripts\"
Copy-Item "$Root\docker-compose.core.yml" "$DeployDir\"
Copy-Item "$Root\scripts\sofascore-monitor" $MonitorDir -Recurse

Write-Host '==> Upload deploy bundle' -ForegroundColor Cyan
scp -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=40 -r `
  "$DeployDir\client" `
  "$DeployDir\server" `
  "$DeployDir\docker-compose.core.yml" `
  "$DeployDir\sofascore-monitor" `
  "${HostName}:/tmp/"

Write-Host '==> Run deploy on server' -ForegroundColor Cyan
ssh -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=40 $HostName "bash -s" @'
set -e
cd /opt/yuce/bbbbb
sudo mkdir -p client/src/components client/src/utils server/src/routes server/src/services server/scripts

sudo cp -r /tmp/client/src/* client/src/
sudo cp -r /tmp/server/src/* server/src/
sudo cp /tmp/server/scripts/upsert-tennis-live-product.js server/scripts/
sudo cp /tmp/server/scripts/upsert-tennis-new-product.js server/scripts/
sudo cp /tmp/docker-compose.core.yml ./
sudo rsync -a /tmp/sofascore-monitor/ scripts/sofascore-monitor/
sudo mkdir -p scripts/sofascore-monitor/config
sudo cp /tmp/sofascore-monitor/config/schedule.json scripts/sofascore-monitor/config/ 2>/dev/null || true

echo "=== build web server ==="
sudo docker compose -f docker-compose.core.yml build web server
sudo docker compose -f docker-compose.core.yml up -d web server

echo "=== upsert products ==="
sudo docker compose -f docker-compose.core.yml exec -T server node scripts/upsert-tennis-live-product.js
sudo docker compose -f docker-compose.core.yml exec -T server node scripts/upsert-tennis-new-product.js

echo "=== restart monitor ==="
sudo systemctl restart sofascore-monitor
sleep 4
systemctl is-active sofascore-monitor

echo "=== apply top100 schedule 4h ==="
curl -s -X POST http://127.0.0.1:9004/schedule -H 'Content-Type: application/json' -H 'Authorization: Bearer sofascore-monitor-2026' -d '{"interval_hours":4}' || true

echo "=== warm caches ==="
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisLiveFromMonitor").refreshLiveBundleFromMonitor().then(function(b){console.log("live",b.events,b.message)}).catch(function(e){console.error(e.message);process.exit(1)})'
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisNewFromMonitor").refreshNewBundleFromMonitor().then(function(b){console.log("new",b.events,b.message)}).catch(function(e){console.error(e.message);process.exit(1)})'

echo "=== verify ==="
curl -s http://127.0.0.1:9004/health
echo
sudo docker compose -f docker-compose.core.yml ps
'@

Write-Host 'Deploy done.' -ForegroundColor Green
