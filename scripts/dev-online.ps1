# 本地连线上库 + 生产 Redis（SSH 隧道）
# 用法（仓库根目录）:
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-online.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Key = Join-Path $env:USERPROFILE '.ssh\lightsail-ap-east-1.pem'
$HostName = 'ubuntu@95.40.77.158'
$ServerDir = Join-Path $Root 'server'
$ClientDir = Join-Path $Root 'client'

if (-not (Test-Path $Key)) { throw "SSH key missing: $Key" }

Write-Host '==> Resolve prod Redis container IP' -ForegroundColor Cyan
$redisIp = (ssh -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=20 $HostName "sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' bbbbb-redis-1").Trim()
if (-not $redisIp) { throw 'cannot resolve bbbbb-redis-1 IP' }
Write-Host "    redis=$redisIp"

function Stop-LocalPort([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }
}

Write-Host '==> SSH tunnels: Redis 16379, Sofa 9004' -ForegroundColor Cyan
Stop-LocalPort 16379
Stop-LocalPort 9004
$tunnel = Start-Process -PassThru -WindowStyle Minimized -FilePath 'ssh' -ArgumentList @(
  '-i', $Key,
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ServerAliveInterval=30',
  '-N',
  '-L', "16379:${redisIp}:6379",
  '-L', '9004:127.0.0.1:9004',
  $HostName
)
Start-Sleep -Seconds 2

# Patch server/.env Redis + local URLs (keep tennisv2)
$envPath = Join-Path $ServerDir '.env'
$raw = Get-Content $envPath -Raw -Encoding UTF8
if ($raw -notmatch '(?m)^REDIS_URL=') {
  $raw = $raw.TrimEnd() + "`r`nREDIS_URL=redis://127.0.0.1:16379`r`n"
} else {
  $raw = [regex]::Replace($raw, '(?m)^REDIS_URL=.*$', 'REDIS_URL=redis://127.0.0.1:16379')
}
$raw = [regex]::Replace($raw, '(?m)^DB_NAME=.*$', 'DB_NAME=tennisv2')
$raw = [regex]::Replace($raw, '(?m)^APP_FRONTEND_URL=.*$', 'APP_FRONTEND_URL=http://localhost:5279')
$raw = [regex]::Replace($raw, '(?m)^APP_PUBLIC_URL=.*$', 'APP_PUBLIC_URL=http://localhost:5279')
$raw = [regex]::Replace($raw, '(?m)^MUSKPAY_WEBSITE=.*$', 'MUSKPAY_WEBSITE=http://localhost:5279')
if ($raw -notmatch '(?m)^SOFA_MONITOR_URL=') {
  $raw = $raw.TrimEnd() + "`r`nSOFA_MONITOR_URL=http://127.0.0.1:9004`r`nSOFA_MONITOR_TOKEN=sofascore-monitor-2026`r`n"
} else {
  $raw = [regex]::Replace($raw, '(?m)^SOFA_MONITOR_URL=.*$', 'SOFA_MONITOR_URL=http://127.0.0.1:9004')
}
if ($raw -notmatch '(?m)^NBA_INTERNAL_URL=') {
  $raw = $raw.TrimEnd() + "`r`nNBA_INTERNAL_URL=http://127.0.0.1:8780`r`nDOTA2_INTERNAL_URL=http://127.0.0.1:8781`r`n"
}
Set-Content -Path $envPath -Value $raw -Encoding UTF8

Write-Host '==> Restart API on :3001 (prod DB tennisv2)' -ForegroundColor Cyan
Stop-LocalPort 3001
Remove-Item Env:ENV_FILE -ErrorAction SilentlyContinue
$env:PORT = '3001'
$api = Start-Process -PassThru -WorkingDirectory $ServerDir -FilePath 'node' -ArgumentList @('src/index.js')

Start-Sleep -Seconds 2
Write-Host '==> Ensure Vite on :5279' -ForegroundColor Cyan
$viteUp = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing http://localhost:5279/ -TimeoutSec 3
  $viteUp = ($r.StatusCode -eq 200)
} catch {}
if (-not $viteUp) {
  Stop-LocalPort 5279
  Start-Process -WorkingDirectory $ClientDir -FilePath 'cmd.exe' -ArgumentList @('/c', 'npm run dev') -WindowStyle Minimized
}

Write-Host ''
Write-Host 'Online local ready:' -ForegroundColor Green
Write-Host '  Frontend  http://localhost:5279/'
Write-Host '  API       http://localhost:3001/api/health'
Write-Host '  MySQL     tennisv2 @ 8.216.45.102:3334'
Write-Host "  Redis     127.0.0.1:16379 -> $redisIp (prod bbbbb-redis-1)"
Write-Host ''
Write-Host 'Close this window or Ctrl+C to stop API/tunnel.' -ForegroundColor Yellow

try { Wait-Process -Id $api.Id } finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
}
