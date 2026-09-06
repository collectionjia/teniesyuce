# 快速部署（按改动范围选 target，避免每次全量 docker build）
# 用法:
#   .\scripts\deploy-fast.ps1 -Target web       # 只改前端 Vue/api（约 3~6 分钟）
#   .\scripts\deploy-fast.ps1 -Target server    # 只改 server JS（约 30 秒，热更新容器）
#   .\scripts\deploy-fast.ps1 -Target monitor   # 只改 sofascore-monitor Python（约 10 秒）
#   .\scripts\deploy-fast.ps1 -Target all       # 等同 deploy-server.ps1 全量
#   .\scripts\deploy-fast.ps1 -Target server -SkipWarm

param(
  [ValidateSet('web', 'server', 'monitor', 'all')]
  [string]$Target = 'web',
  [switch]$SkipWarm
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Key = if ($env:DEV_SSH_KEY) { $env:DEV_SSH_KEY } else { Join-Path $env:USERPROFILE 'Desktop\LightsailDefaultKey-ap-east-1 (2).pem' }
if (-not (Test-Path $Key)) { $Key = Join-Path $env:USERPROFILE '.ssh\lightsail-57-145.pem' }
$HostName = if ($env:DEV_SSH_HOST) { $env:DEV_SSH_HOST } else { 'ubuntu@95.40.57.145' }
if (-not (Test-Path $Key)) { throw "SSH key missing: $Key" }

function Copy-DeployItem {
  param([string]$RelPath, [string]$DeployDir)
  $src = Join-Path $Root ($RelPath -replace '/', '\')
  $dest = Join-Path $DeployDir ($RelPath -replace '/', '\')
  if (-not (Test-Path $src)) { return $false }
  $destDir = Split-Path $dest -Parent
  if ($destDir) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
  Copy-Item $src $dest -Force
  return $true
}

$DeployDir = Join-Path $Root 'tmp-deploy-fast'
Remove-Item $DeployDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null

$clientFiles = @(
  'client/src/App.vue', 'client/src/api.js', 'client/src/productIcons.js',
  'client/src/components/TennisBoard.vue', 'client/src/components/SofaMonitor.vue',
  'client/src/utils/tennisLiveFilter.js', 'client/src/utils/tennisRangeFilter.js',
  'client/src/utils/sofaMatchUrl.js'
)
$serverFiles = @(
  'server/src/index.js',
  'server/src/routes/sofaMonitor.js', 'server/src/routes/tennis.js',
  'server/src/routes/tennisLive.js', 'server/src/routes/tennisNew.js', 'server/src/routes/admin.js',
  'server/src/services/tennisFromMonitor.js', 'server/src/services/tennisDataSource.js',
  'server/src/services/allsports.js', 'server/src/services/tennisLiveFilter.js',
  'server/src/services/tennisLiveFromMonitor.js', 'server/src/services/tennisLiveCache.js',
  'server/src/services/tennisNewCache.js', 'server/src/services/tennisNewFromMonitor.js',
  'server/src/services/tennisRangeFilter.js', 'server/src/services/tennisRangeFromMonitor.js',
  'server/src/services/tennisTrade.js', 'server/src/services/tradeRecords.js',
  'server/src/services/tennisPolymarketMatch.js'
)

$uploadPaths = @()
if ($Target -in @('web', 'all')) {
  foreach ($f in $clientFiles) { if (Copy-DeployItem $f $DeployDir) { } }
  $uploadPaths += 'client'
}
if ($Target -in @('server', 'all')) {
  foreach ($f in $serverFiles) { Copy-DeployItem $f $DeployDir | Out-Null }
  Copy-DeployItem 'server/scripts/upsert-tennis-live-product.js' $DeployDir | Out-Null
  Copy-DeployItem 'server/scripts/upsert-tennis-new-product.js' $DeployDir | Out-Null
  $uploadPaths += 'server'
}
if ($Target -in @('monitor', 'all')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'sofascore-monitor') | Out-Null
  Copy-Item (Join-Path $Root 'scripts\sofascore-monitor\*') (Join-Path $DeployDir 'sofascore-monitor') -Recurse -Force
  $uploadPaths += 'sofascore-monitor'
}

Write-Host "==> fast deploy target=$Target host=$HostName" -ForegroundColor Cyan
$scpArgs = @('-i', $Key, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=40', '-r')
foreach ($p in $uploadPaths) { $scpArgs += (Join-Path $DeployDir $p) }
$scpArgs += "${HostName}:/tmp/"
& scp @scpArgs

$warmBlock = if ($SkipWarm) { '' } else @'
echo "=== warm redis ==="
sudo docker compose -f docker-compose.core.yml exec -T server node -e 'require("./src/services/tennisFromMonitor").refreshRedisFromMonitor({includeLive:true}).then(function(b){console.log("redis",b.events,b.upstream||b.source)}).catch(function(e){console.error(e.message);process.exit(1)})' || true
'@

$remote = switch ($Target) {
  'web' { @'
set -e
cd /opt/yuce/bbbbb
sudo cp -r /tmp/client/src/* client/src/
echo "=== build web only ==="
sudo docker compose -f docker-compose.core.yml build web
sudo docker compose -f docker-compose.core.yml up -d web
sudo docker compose -f docker-compose.core.yml ps web
'@ }
  'server' { @'
set -e
cd /opt/yuce/bbbbb
sudo mkdir -p server/src/routes server/src/services server/scripts
sudo cp -r /tmp/server/src/routes/* server/src/routes/ 2>/dev/null || true
sudo cp -r /tmp/server/src/services/* server/src/services/ 2>/dev/null || true
sudo cp /tmp/server/src/index.js server/src/ 2>/dev/null || true
sudo cp /tmp/server/scripts/*.js server/scripts/ 2>/dev/null || true
CID=$(sudo docker compose -f docker-compose.core.yml ps -q server)
echo "=== hotfix server container $CID ==="
for f in server/src/routes/*.js server/src/services/*.js server/src/index.js; do
  [ -f "$f" ] && sudo docker cp "$f" "$CID:/app/${f#server/}"
done
for f in server/scripts/*.js; do
  [ -f "$f" ] && sudo docker cp "$f" "$CID:/app/scripts/$(basename "$f")"
done
sudo docker compose -f docker-compose.core.yml restart server
sleep 2
sudo docker compose -f docker-compose.core.yml ps server
'@ + "`n$warmBlock" }
  'monitor' { @'
set -e
cd /opt/yuce/bbbbb
sudo rsync -a /tmp/sofascore-monitor/ scripts/sofascore-monitor/
echo "=== restart monitor ==="
sudo systemctl restart sofascore-monitor
sleep 2
systemctl is-active sofascore-monitor
curl -sf http://127.0.0.1:9004/health && echo
'@ }
  'all' {
    & (Join-Path $Root 'scripts\deploy-server.ps1')
    exit $LASTEXITCODE
  }
}

if ($Target -ne 'all') {
  Write-Host '==> run on server' -ForegroundColor Cyan
  ssh -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=40 $HostName "bash -s" $remote
  Write-Host "Fast deploy ($Target) done." -ForegroundColor Green
}
