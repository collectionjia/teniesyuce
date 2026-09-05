# CodeBuddy HTTP API 本地服务启动脚本
# 文档: https://www.workbuddy.cn/docs/cli/http-api

param(
    [int]$Port = 8080,
    [switch]$WithAuth
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command codebuddy -ErrorAction SilentlyContinue)) {
    Write-Host "未找到 codebuddy CLI，请先安装:" -ForegroundColor Red
    Write-Host "  npm install -g @tencent-ai/codebuddy-code"
    exit 1
}

$env:CODEBUDDY_DISABLE_REQUEST_VALIDATION = "1"

if ($WithAuth) {
    Write-Host "启动 CodeBuddy HTTP 服务 (端口 $Port, 密码认证)..." -ForegroundColor Cyan
    codebuddy --serve --port $Port --auth password
} else {
    Write-Host "启动 CodeBuddy HTTP 服务 (端口 $Port, 本机无认证)..." -ForegroundColor Cyan
    Write-Host "仅建议在 localhost 使用 --auth none" -ForegroundColor Yellow
    $env:CODEBUDDY_GATEWAY_AUTH = "none"
    codebuddy --serve --port $Port --auth none
}
