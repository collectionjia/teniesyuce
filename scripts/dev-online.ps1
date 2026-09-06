# 本地连线上 MySQL + 生产 Redis（SSH 隧道 9014 / 9004）
# 用法（仓库根目录）:
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-online.ps1
#
# 可选环境变量:
#   DEV_SSH_KEY   SSH 私钥路径
#   DEV_SSH_HOST  默认 ubuntu@95.40.57.145

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Key = if ($env:DEV_SSH_KEY) { $env:DEV_SSH_KEY } else { Join-Path $env:USERPROFILE 'Desktop\LightsailDefaultKey-ap-east-1 (2).pem' }
if (-not (Test-Path $Key)) {
  $Key = Join-Path $env:USERPROFILE '.ssh\lightsail-ap-east-1.pem'
}
$HostName = if ($env:DEV_SSH_HOST) { $env:DEV_SSH_HOST } else { 'ubuntu@95.40.57.145' }
$ServerDir = Join-Path $Root 'server'
$ClientDir = Join-Path $Root 'client'

if (-not (Test-Path $Key)) { throw "SSH key missing: $Key" }

function Stop-LocalPort([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }
}

Write-Host '==> SSH tunnels: Redis 9014, Sofa 9004' -ForegroundColor Cyan
Stop-LocalPort 9014
Stop-LocalPort 9004
Get-Job -Name 'yuce-tunnel' -ErrorAction SilentlyContinue | Stop-Job -PassThru | Remove-Job -Force
Start-Sleep -Seconds 1
$tunnel = Start-Job -Name 'yuce-tunnel' -ScriptBlock {
  param($KeyPath, $Remote)
  & ssh -i $KeyPath -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -N `
    -L 127.0.0.1:9014:127.0.0.1:9014 `
    -L 127.0.0.1:9004:127.0.0.1:9004 `
    $Remote
} -ArgumentList $Key, $HostName
Start-Sleep -Seconds 5
if ($tunnel.State -eq 'Failed') {
  Receive-Job $tunnel -ErrorAction SilentlyContinue
  throw 'SSH tunnel job failed'
}

$envPath = Join-Path $ServerDir '.env'
$raw = Get-Content $envPath -Raw -Encoding UTF8
if ($raw -notmatch '(?m)^REDIS_URL=') {
  $raw = $raw.TrimEnd() + "`r`nREDIS_URL=redis://127.0.0.1:9014`r`n"
} else {
  $raw = [regex]::Replace($raw, '(?m)^REDIS_URL=.*$', 'REDIS_URL=redis://127.0.0.1:9014')
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
Set-Content -Path $envPath -Value $raw -Encoding UTF8

Push-Location $ServerDir
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$redisOk = $false
for ($i = 0; $i -lt 10; $i++) {
  node -e "const {createClient}=require('redis');(async()=>{const c=createClient({url:'redis://127.0.0.1:9014'});await c.connect();console.log('redis',await c.ping(),'keys',(await c.keys('tennis:*')).length);await c.quit()})().catch(e=>{console.error(e.message);process.exit(1)})" 2>$null
  if ($LASTEXITCODE -eq 0) { $redisOk = $true; break }
  Start-Sleep -Seconds 1
}
$ErrorActionPreference = $prevEap
if (-not $redisOk) {
  Pop-Location
  throw 'Redis tunnel failed — check server port 9014'
}
Pop-Location

Write-Host '==> Start API on :3001 (prod DB tennisv2)' -ForegroundColor Cyan
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
Write-Host '  MySQL     tennisv2 (server/.env DB_HOST)'
Write-Host "  Redis     127.0.0.1:9014 -> $HostName`:9014 (prod tennis bundles)"
Write-Host '  Sofa      127.0.0.1:9004 (optional monitor API)'
Write-Host ''
Write-Host 'Close this window or Ctrl+C to stop API/tunnel.' -ForegroundColor Yellow

try { Wait-Process -Id $api.Id } finally {
  Get-Job -Name 'yuce-tunnel' -ErrorAction SilentlyContinue | Stop-Job -PassThru | Remove-Job -Force
  if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
}
