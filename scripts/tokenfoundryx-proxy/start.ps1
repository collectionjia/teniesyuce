# TokenFoundryX local proxy for Cursor
# Start: powershell -ExecutionPolicy Bypass -File .\start.ps1

param(
  [string]$ApiKey = $env:TFX_API_KEY,
  [string]$Upstream = "https://www.tokenfoundryx.com",
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $ApiKey) {
  $ApiKey = "sk-SsvDOM3Pl9uJBiRIPK5rSKIIZSOnYfHu78MNV9Tykm1SuWy6"
}

$env:TFX_API_KEY = $ApiKey
$env:TFX_UPSTREAM = $Upstream
$env:TFX_PROXY_PORT = "$Port"
$env:TFX_DEFAULT_MODEL = "gpt-5.6-sol"

Write-Host "Starting proxy on http://127.0.0.1:$Port/v1" -ForegroundColor Cyan
Write-Host "Upstream: $Upstream"
python "$here\proxy.py"
