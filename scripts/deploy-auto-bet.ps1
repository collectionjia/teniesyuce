# 仅部署自动投注相关前端
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\deploy-auto-bet.ps1

$ErrorActionPreference = 'Stop'
$Key = Join-Path $env:USERPROFILE '.ssh\lightsail-ap-east-1.pem'
$HostName = 'ubuntu@95.40.77.158'
$Root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $Key)) { throw "SSH key missing: $Key" }

Write-Host '==> Upload auto-bet files' -ForegroundColor Cyan
scp -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=40 `
  (Join-Path $Root 'client\src\btcVirtualBet.js') `
  (Join-Path $Root 'client\src\components\BtcBoard.vue') `
  (Join-Path $Root 'client\src\components\TennisBoard.vue') `
  (Join-Path $Root 'tmp_patch_auto_bet_labels.py') `
  "${HostName}:/tmp/"

Write-Host '==> Install + rebuild web only' -ForegroundColor Cyan
ssh -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=40 $HostName @'
set -e
sudo cp /tmp/btcVirtualBet.js /opt/yuce/bbbbb/client/src/btcVirtualBet.js
sudo cp /tmp/BtcBoard.vue /opt/yuce/bbbbb/client/src/components/BtcBoard.vue
sudo cp /tmp/TennisBoard.vue /opt/yuce/bbbbb/client/src/components/TennisBoard.vue
sudo python3 /tmp/tmp_patch_auto_bet_labels.py
sudo touch /opt/yuce/bbbbb/client/src/btcVirtualBet.js
cd /opt/yuce/bbbbb
sudo docker compose -f docker-compose.core.yml build web
sudo docker compose -f docker-compose.core.yml up -d --force-recreate web
sudo docker compose -f docker-compose.core.yml ps web
sleep 2
sudo docker exec bbbbb-web-1 sh -c "grep -Rao 自动投注 /usr/share/nginx/html/assets/*.js | wc -l"
'@

Write-Host 'Done. Site: https://www.yuce.bid/' -ForegroundColor Green
