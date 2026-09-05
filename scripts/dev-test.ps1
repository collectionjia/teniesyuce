# 本地测试环境启动：
# 1) 远端 tennisv2_test（自动建库/表/种子）
# 2) Lightsail 独立 redis-test（127.0.0.1:6380）
# 3) SSH 隧道 Redis → 127.0.0.1:16379（可选 Sofa 9004）
# 4) server(.env.test) + client(vite)
#
# 用法（仓库根目录）:
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-test.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'server\package.json'))) {
  $Root = (Get-Location).Path
}

$Key = Join-Path $env:USERPROFILE '.ssh\lightsail-ap-east-1.pem'
$HostName = 'ubuntu@95.40.77.158'
$ServerDir = Join-Path $Root 'server'
$ClientDir = Join-Path $Root 'client'
$EnvTest = Join-Path $ServerDir '.env.test'

if (-not (Test-Path $Key)) { throw "SSH key not found: $Key" }
if (-not (Test-Path $EnvTest)) { throw "Missing $EnvTest" }

Write-Host '==> Ensure test Redis on Lightsail (127.0.0.1:6380)' -ForegroundColor Cyan
ssh -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=20 $HostName @'
set -e
if ! sudo docker ps -a --format "{{.Names}}" | grep -qx bbbbb-redis-test; then
  sudo docker run -d --name bbbbb-redis-test --restart unless-stopped \
    -p 127.0.0.1:6380:6379 redis:7-alpine redis-server --appendonly yes
else
  sudo docker start bbbbb-redis-test >/dev/null || true
fi
sudo docker exec bbbbb-redis-test redis-cli ping
'@

Write-Host '==> Setup tennisv2_test schema/seed' -ForegroundColor Cyan
Push-Location $ServerDir
$env:ENV_FILE = '.env.test'
node scripts/setup-test-db.js
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'setup-test-db failed' }
Pop-Location

function Stop-LocalPort([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
    }
}

Write-Host '==> SSH tunnels: Redis 16379, Sofa 9004' -ForegroundColor Cyan
Stop-LocalPort 16379
Stop-LocalPort 9004
$tunnel = Start-Process -PassThru -WindowStyle Minimized -FilePath 'ssh' -ArgumentList @(
  '-i', $Key,
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ServerAliveInterval=30',
  '-N',
  '-L', '16379:127.0.0.1:6380',
  '-L', '9004:127.0.0.1:9004',
  $HostName
)
Start-Sleep -Seconds 2

Push-Location $ServerDir
node -e "const {createClient}=require('redis');(async()=>{const c=createClient({url:'redis://127.0.0.1:16379'});await c.connect();console.log('redis tunnel',await c.ping());await c.quit()})().catch(e=>{console.error(e.message);process.exit(1)})"
if ($LASTEXITCODE -ne 0) {
  Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  Pop-Location
  throw 'Redis tunnel failed'
}
Pop-Location

Write-Host '==> Start API on :3001 (ENV_FILE=.env.test)' -ForegroundColor Cyan
$env:ENV_FILE = '.env.test'
$api = Start-Process -PassThru -WorkingDirectory $ServerDir -FilePath 'node' -ArgumentList @('scripts/run-test.js')

Start-Sleep -Seconds 2

Write-Host '==> Start Vite on :5279' -ForegroundColor Cyan
$web = Start-Process -PassThru -WorkingDirectory $ClientDir -FilePath 'cmd.exe' -ArgumentList @('/c', 'npm run dev')

Write-Host ''
Write-Host 'Test env ready:' -ForegroundColor Green
Write-Host '  Frontend  http://localhost:5279'
Write-Host '  API       http://localhost:3001/api/health'
Write-Host '  MySQL     tennisv2_test @ 8.216.45.102:3334'
Write-Host '  Redis     127.0.0.1:16379 -> Lightsail bbbbb-redis-test'
Write-Host '  Admin     admin@test.local / test123456'
Write-Host ''
Write-Host 'Close this window or press Ctrl+C to stop.' -ForegroundColor Yellow

try {
  Wait-Process -Id $api.Id
} finally {
  foreach ($p in @($web, $api, $tunnel)) {
    if ($null -ne $p -and -not $p.HasExited) {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
