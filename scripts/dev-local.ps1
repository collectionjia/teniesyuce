# 本机调试（Windows）：开两个窗口跑 API + Vite
# 用法（仓库根目录）: powershell -ExecutionPolicy Bypass -File scripts/dev-local.ps1
# 浏览器: http://localhost:5279/

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "server\.env"))) {
  Write-Error "缺少 server\.env，请先: copy server\.env.example server\.env 并填写 DB_/REDIS"
}

$ClientEnv = Join-Path $Root "client\.env.local"
if (-not (Test-Path $ClientEnv)) {
  @"
VITE_API_PROXY_TARGET=http://127.0.0.1:3001
"@ | Set-Content -Path $ClientEnv -Encoding utf8
  Write-Host "已创建 client\.env.local -> 本机 3001"
}

Write-Host "==> API  http://127.0.0.1:3001"
Write-Host "==> Web  http://localhost:5279/"
Write-Host "请在 Windows 终端跑（不要用 WSL 的 /mnt/d，会很慢）"
Write-Host ""

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$Root\server'; npm run dev"
)
Start-Sleep -Seconds 1
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$Root\client'; npm run dev"
)

Write-Host "已打开 server / client 两个窗口。关闭窗口即停止。"
