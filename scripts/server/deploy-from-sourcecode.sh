#!/usr/bin/env bash
# �?GitHub 拉源�?�?同步到运行目�?�?构建并重�?# 用法: bash /opt/yuce/deploy-from-sourcecode.sh
# �?   bash scripts/server/deploy-from-sourcecode.sh

set -euo pipefail

SOURCE_DIR="${YUCE_SOURCE_DIR:-/opt/yuce/sourcecode}"
RUN_DIR="${YUCE_RUN_DIR:-/opt/yuce}"
UPDATE_SCRIPT="${YUCE_UPDATE_SCRIPT:-/opt/yuce/update-sourcecode.sh}"
LOG_TAG="[yuce-deploy]"

log() { echo "${LOG_TAG} $*"; }
die() { echo "${LOG_TAG} ERROR: $*" >&2; exit 1; }

if [[ -x "$UPDATE_SCRIPT" ]]; then
  bash "$UPDATE_SCRIPT"
elif [[ -f "${SOURCE_DIR}/scripts/server/update-sourcecode.sh" ]]; then
  bash "${SOURCE_DIR}/scripts/server/update-sourcecode.sh"
else
  die "找不�?update 脚本，请�?clone: ${SOURCE_DIR}"
fi

[[ -d "$SOURCE_DIR/.git" ]] || die "源码目录无效: ${SOURCE_DIR}"

log "同步 ${SOURCE_DIR} �?${RUN_DIR}"
sudo mkdir -p "$RUN_DIR"
sudo rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'server/.env' \
  --exclude 'scripts/tennis-monitor/monitor.env' \
  --exclude 'scripts/tennis-monitor/venv/' \
  --exclude 'scripts/tennis-monitor/output/' \
  --exclude 'scripts/tennis-monitor/logs/' \
  --exclude 'tmp-deploy/' \
  --exclude '.cursor/' \
  "${SOURCE_DIR}/" "${RUN_DIR}/"

cd "$RUN_DIR"

log "构建并启�?web + server + redis"
sudo docker compose -f docker-compose.core.yml build web server
sudo docker compose -f docker-compose.core.yml up -d

# 产品注册请手动执�?upsert-tennis-*-product.js（发版不自动跑，避免重复创建�?
log "重启网球数据采集"
sudo cp scripts/tennis-monitor/tennis-monitor.service /etc/systemd/system/ 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable tennis-monitor 2>/dev/null || true
sudo systemctl restart tennis-monitor
sleep 4
systemctl is-active tennis-monitor

log "设置 Top100 定时 4 小时"
curl -sf -X POST http://127.0.0.1:9004/schedule \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sofascore-monitor-2026' \
  -d '{"interval_hours":4}' || log "schedule API 跳过（监控未就绪�?

log "预热 Redis 缓存"
sudo docker compose -f docker-compose.core.yml exec -T server node -e \
  'require("./src/services/tennisLiveFromMonitor").refreshLiveBundleFromMonitor().then(b=>console.log("live",b.events)).catch(e=>{console.error(e.message);process.exit(1)})'
sudo docker compose -f docker-compose.core.yml exec -T server node -e \
  'require("./src/services/tennisNewFromMonitor").refreshNewBundleFromMonitor().then(b=>console.log("new",b.events)).catch(e=>{console.error(e.message);process.exit(1)})'

head="$(git -C "$SOURCE_DIR" rev-parse --short HEAD)"
log "部署完成 @ ${head} $(git -C "$SOURCE_DIR" log -1 --format='%s')"
curl -sf http://127.0.0.1:9004/health && echo
sudo docker compose -f docker-compose.core.yml ps
