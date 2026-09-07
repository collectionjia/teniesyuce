# 部署 web + server + tennis-monitor 到生�?
# 用法: powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Key = if ($env:DEV_SSH_KEY) { $env:DEV_SSH_KEY } else { Join-Path $env:USERPROFILE 'Desktop\LightsailDefaultKey-ap-east-1 (2).pem' }
if (-not (Test-Path $Key)) { $Key = Join-Path $env:USERPROFILE '.ssh\lightsail-ap-east-1.pem' }
$HostName = if ($env:DEV_SSH_HOST) { $env:DEV_SSH_HOST } else { 'ubuntu@95.40.57.145' }

if (-not (Test-Path $Key)) { throw "SSH key missing: $Key" }

function Copy-DeployItem {
  param([string]$RelPath, [switch]$Recurse)
  $src = Join-Path $Root ($RelPath -replace '/', '\')
  $dest = Join-Path $DeployDir ($RelPath -replace '/', '\')
  if (-not (Test-Path $src)) {
    Write-Host "skip missing $RelPath" -ForegroundColor DarkYellow
    return
  }
  $destDir = Split-Path $dest -Parent
  if ($destDir) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
  if ($Recurse) { Copy-Item $src $dest -Recurse -Force }
  else { Copy-Item $src $dest -Force }
}

$DeployDir = Join-Path $Root 'tmp-deploy'
$MonitorDir = Join-Path $DeployDir 'tennis-monitor'
Remove-Item $DeployDir -Recurse -Force -ErrorAction SilentlyContinue

@(
  'client/src/App.vue',
  'client/src/api.js',
  'client/src/productIcons.js',
  'client/src/components/TennisBoard.vue',
  'client/src/components/TennisLiveMonitor.vue',
  'client/src/components/LiveTop100Scraper.vue',
  'client/src/components/TennisMonitor.vue',
  'client/src/utils/tennisLiveFilter.js',
  'client/src/utils/tennisRangeFilter.js',
  'client/src/utils/sofaMatchUrl.js',
  'server/src/index.js',
  'server/src/routes/tennisMonitor.js',
  'server/src/routes/tennis.js',
  'server/src/routes/tennisLive.js',
  'server/src/routes/tennisLiveMonitor.js',
  'server/src/routes/tennisLiveScraper.js',
  'server/src/routes/tennisNew.js',
  'server/src/routes/admin.js',
  'server/src/services/tennisFromMonitor.js',
  'server/src/services/tennisDataSource.js',
  'server/src/services/allsports.js',
  'server/src/services/tennisLiveFilter.js',
  'server/src/services/tennisLiveFromMonitor.js',
  'server/src/services/tennisLiveCache.js',
  'server/src/services/tennisNewCache.js',
  'server/src/services/tennisNewFromMonitor.js',
  'server/src/services/tennisRangeFilter.js',
  'server/src/services/tennisRangeFromMonitor.js',
  'server/src/services/tennisTrade.js',
  'server/src/services/tradeRecords.js',
  'server/src/services/tennisPolymarketMatch.js',
  'server/src/services/sofaMonitorTop100.js',
  'server/scripts/upsert-tennis-live-product.js',
  'server/scripts/upsert-tennis-new-product.js',
  'docker-compose.core.yml'
) | ForEach-Object { Copy-DeployItem $_ }

New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'tennis-monitor') | Out-Null
Copy-Item (Join-Path $Root 'scripts\tennis-monitor\*') (Join-Path $DeployDir 'tennis-monitor') -Recurse -Force

Write-Host '==> Upload deploy bundle' -ForegroundColor Cyan
scp -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=40 -r `
  "$DeployDir\client" `
  "$DeployDir\server" `
  "$DeployDir\docker-compose.core.yml" `
  "$DeployDir\tennis-monitor" `
  "${HostName}:/tmp/"

Write-Host '==> Run deploy on server' -ForegroundColor Cyan
ssh -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=40 $HostName "bash -s" @'
set -e
cd /opt/yuce
sudo mkdir -p client/src/components client/src/utils server/src/routes server/src/services server/scripts

sudo cp -r /tmp/client/src/* client/src/
sudo cp -r /tmp/server/src/* server/src/
sudo cp /tmp/server/scripts/upsert-tennis-live-product.js server/scripts/
sudo cp /tmp/server/scripts/upsert-tennis-new-product.js server/scripts/
sudo cp /tmp/docker-compose.core.yml ./
sudo rsync -a /tmp/tennis-monitor/ scripts/tennis-monitor/
sudo mkdir -p scripts/tennis-monitor/config
sudo cp /tmp/tennis-monitor/config/schedule.json scripts/tennis-monitor/config/ 2>/dev/null || true

echo "=== build web server ==="
sudo docker compose -f docker-compose.core.yml build web server
sudo docker compose -f docker-compose.core.yml up -d web server

# 产品注册脚本仅首次或手动维护时运行，发版默认不执行（避免重复 INSERT�?
# 需要时: docker compose exec server node scripts/upsert-tennis-live-product.js

echo "=== restart monitor ==="
sudo systemctl restart tennis-monitor
sleep 4
systemctl is-active tennis-monitor

echo "=== apply top100 schedule 4h ==="
curl -s -X POST http://127.0.0.1:9004/schedule -H 'Content-Type: application/json' -H 'Authorization: Bearer sofascore-monitor-2026' -d '{"interval_hours":4}' || true

echo "=== warm caches ==="
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisFromMonitor").refreshRedisFromMonitor({includeLive:true}).then(function(b){console.log("redis",b.events,b.upstream||b.source,b.message)}).catch(function(e){console.error(e.message);process.exit(1)})'
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisLiveFromMonitor").refreshLiveBundleFromMonitor().then(function(b){console.log("live",b.events,b.message)}).catch(function(e){console.error(e.message);process.exit(1)})'
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisNewFromMonitor").refreshNewBundleFromMonitor().then(function(b){console.log("new",b.events,b.message)}).catch(function(e){console.error(e.message);process.exit(1)})'

echo "=== verify ==="
curl -s http://127.0.0.1:9004/health
echo
sudo docker compose -f docker-compose.core.yml ps
'@

Write-Host 'Deploy done.' -ForegroundColor Green
