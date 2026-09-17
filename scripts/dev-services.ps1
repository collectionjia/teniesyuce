# 本地启动五引擎 stub + scheduler（需已配置 services/scheduler/.env 的 DB/Redis）
$root = Split-Path -Parent $PSScriptRoot
$services = @(
  @{ name = "collect"; port = 9101; dir = "collect" },
  @{ name = "rules"; port = 9102; dir = "rules" },
  @{ name = "betting"; port = 9103; dir = "betting" },
  @{ name = "stop-loss"; port = 9104; dir = "stop-loss" },
  @{ name = "scheduler"; port = 9105; dir = "scheduler" }
)

foreach ($s in $services) {
  $dir = Join-Path $root "services\$($s.dir)"
  if (-not (Test-Path (Join-Path $dir "node_modules"))) {
    Write-Host "npm install $($s.dir)..."
    Push-Location $dir
    npm install --silent
    Pop-Location
  }
}

Write-Host "Starting services (new windows)..."
$envFile = Join-Path $root "server\.env"
$serverRoot = Join-Path $root "server"
foreach ($s in $services) {
  $dir = Join-Path $root "services\$($s.dir)"
  $extra = ""
  if ($s.dir -eq "scheduler") {
    $extra = "`$env:EXECUTOR_MODE='http'; `$env:COLLECT_URL='http://127.0.0.1:9101'; `$env:RULES_URL='http://127.0.0.1:9102'; `$env:BETTING_URL='http://127.0.0.1:9103'; `$env:STOP_LOSS_URL='http://127.0.0.1:9104'; "
  }
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$dir'; `$env:ENV_FILE='$envFile'; `$env:SERVER_ROOT='$serverRoot'; `$env:PORT=$($s.port); $extra npm run dev"
}

Write-Host "Health:"
Start-Sleep -Seconds 2
foreach ($s in $services) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$($s.port)/health" -TimeoutSec 3
    Write-Host "  $($s.name) :$($s.port) ok=$($r.ok)"
  } catch {
    Write-Host "  $($s.name) :$($s.port) pending..."
  }
}
