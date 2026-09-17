# 本地一键：五引擎 + server(3001) + 提示 client
$root = Split-Path -Parent $PSScriptRoot
Write-Host "==> 五引擎 services"
powershell -NoProfile -File (Join-Path $root "scripts\dev-services.ps1")
Start-Sleep -Seconds 2
Write-Host ""
Write-Host "==> server :3001（勿在同一终端设 PORT=910x）"
$serverDir = Join-Path $root "server"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$serverDir'; Remove-Item Env:PORT -ErrorAction SilentlyContinue; Remove-Item Env:ENV_FILE -ErrorAction SilentlyContinue; npm run dev"
Write-Host ""
Write-Host "client: cd client && npm run dev  ->  http://127.0.0.1:5279"
Write-Host "管理: 管理中心 -> 服务类 -> 五引擎服务"
