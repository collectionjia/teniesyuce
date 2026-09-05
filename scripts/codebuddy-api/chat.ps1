param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt,

    [string]$BaseUrl = "http://127.0.0.1:8080",
    [string]$Cwd = (Get-Location).Path,
    [string]$Token = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$jobFile = Join-Path $scriptDir "last-job.json"

$headers = @{
    "X-CodeBuddy-Request" = "1"
    "Content-Type"        = "application/json"
}
if ($Token) {
    $headers["Authorization"] = "Bearer $Token"
}

$bodyObj = @{
    prompt         = $Prompt
    cwd            = $Cwd
    agent          = "minimal"
    permissionMode = "dontAsk"
}
$body = $bodyObj | ConvertTo-Json -Compress
$utf8Body = [System.Text.Encoding]::UTF8.GetBytes($body)

Write-Host "发送请求到 $BaseUrl ..." -ForegroundColor Cyan
$response = Invoke-RestMethod -Uri "$BaseUrl/api/v1/jobs" -Method Post -Headers $headers -Body $utf8Body
$job = $response.data
if (-not $job) { throw "创建 job 失败: $($response | ConvertTo-Json -Depth 6)" }

$jobId = $job.id
Write-Host "job id: $jobId" -ForegroundColor Green
$job | ConvertTo-Json -Depth 6 | Set-Content -Path $jobFile -Encoding UTF8

Write-Host "等待回复..." -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(90)
$assistantText = @()

while ((Get-Date) -lt $deadline) {
    $transcript = Invoke-RestMethod -Uri "$BaseUrl/api/v1/jobs/$jobId/transcript" -Method Get -Headers $headers
    $updates = @($transcript.data.updates)

    foreach ($item in $updates) {
        $updateType = [string]$item.sessionUpdate
        if ($updateType -match "agent|assistant") {
            $text = $item.content.text
            if ($text) { $assistantText += [string]$text }
        }
    }

    $detail = Invoke-RestMethod -Uri "$BaseUrl/api/v1/jobs/$jobId" -Method Get -Headers $headers
    $state = [string]$detail.data.job.state
    $status = [string]$detail.data.job.status

    if ($assistantText.Count -gt 0 -or $state -in @("done", "failed", "stopped")) {
        break
    }

    Write-Host "  state=$state status=$status" -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
}

if ($assistantText.Count -eq 0) {
    Write-Host "暂未拿到 assistant 回复。可能还在 preparing，或 CLI 未完成登录。" -ForegroundColor Yellow
    Write-Host "请先执行: codebuddy" -ForegroundColor Yellow
    Write-Host "Web UI: $BaseUrl/" -ForegroundColor Yellow
    $transcript | ConvertTo-Json -Depth 20
    exit 2
}

Write-Output ($assistantText -join "")
