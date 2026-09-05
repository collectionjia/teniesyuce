# Check CodeBuddy HTTP service and CLI

param(
    [string]$BaseUrl = "http://127.0.0.1:8080"
)

$headers = @{ "X-CodeBuddy-Request" = "1" }

Write-Host "=== CodeBuddy local API check ===" -ForegroundColor Cyan

try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/api/v1/health" -Headers $headers
    Write-Host "[OK] HTTP server: $($health.data.status), uptime=$($health.data.uptime)" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] HTTP server is not running" -ForegroundColor Red
    Write-Host "Run: .\start-server.ps1"
    exit 1
}

try {
    $auth = Invoke-RestMethod -Uri "$BaseUrl/api/v1/auth/status" -Headers $headers
    Write-Host "[OK] authEnabled=$($auth.authEnabled) authenticated=$($auth.authenticated)" -ForegroundColor Green
} catch {
    Write-Host "[WARN] cannot read auth/status" -ForegroundColor Yellow
}

if (-not (Get-Command codebuddy -ErrorAction SilentlyContinue)) {
    Write-Host "[FAIL] codebuddy CLI not installed" -ForegroundColor Red
    Write-Host "Install: npm install -g @tencent-ai/codebuddy-code"
    exit 1
}

$version = codebuddy --version
Write-Host "[OK] codebuddy CLI version: $version" -ForegroundColor Green

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. If CLI never logged in, run: codebuddy"
Write-Host "2. Start server: .\start-server.ps1"
Write-Host "3. Open Web UI: $BaseUrl/"
Write-Host "4. Test chat: .\chat.ps1 -Prompt hello"
