#!/usr/bin/env bash
# 从 GitHub 拉源码 → 同步到运行目录 → 构建并重启
# 用法: bash /opt/yuce/deploy-from-sourcecode.sh
# 或:   bash scripts/server/deploy-from-sourcecode.sh

set -euo pipefail

SOURCE_DIR="${YUCE_SOURCE_DIR:-/opt/yuce/sourcecode}"
RUN_DIR="${YUCE_RUN_DIR:-/opt/yuce/bbbbb}"
UPDATE_SCRIPT="${YUCE_UPDATE_SCRIPT:-/opt/yuce/update-sourcecode.sh}"
LOG_TAG="[yuce-deploy]"

log() { echo "${LOG_TAG} $*"; }
die() { echo "${LOG_TAG} ERROR: $*" >&2; exit 1; }

if [[ -x "$UPDATE_SCRIPT" ]]; then
  bash "$UPDATE_SCRIPT"
elif [[ -f "${SOURCE_DIR}/scripts/server/update-sourcecode.sh" ]]; then
  bash "${SOURCE_DIR}/scripts/server/update-sourcecode.sh"
else
  die "找不到 update 脚本，请先 clone: ${SOURCE_DIR}"
fi

[[ -d "$SOURCE_DIR/.git" ]] || die "源码目录无效: ${SOURCE_DIR}"

log "同步 ${SOURCE_DIR} → ${RUN_DIR}"
sudo mkdir -p "$RUN_DIR"
sudo rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'server/.env' \
  --exclude 'scripts/sofascore-monitor/venv/' \
  --exclude 'scripts/sofascore-monitor/output/' \
  --exclude 'scripts/sofascore-monitor/logs/' \
  --exclude 'tmp-deploy/' \
  --exclude '.cursor/' \
  "${SOURCE_DIR}/" "${RUN_DIR}/"

cd "$RUN_DIR"

log "构建 web + server"
sudo docker compose -f docker-compose.core.yml build web server
sudo docker compose -f docker-compose.core.yml up -d web server

log "注册产品"
sudo docker compose -f docker-compose.core.yml exec -T server node scripts/upsert-tennis-live-product.js
sudo docker compose -f docker-compose.core.yml exec -T server node scripts/upsert-tennis-new-product.js

log "重启 Sofascore 监控"
sudo systemctl restart sofascore-monitor
sleep 4
systemctl is-active sofascore-monitor

log "设置 Top100 定时 4 小时"
curl -sf -X POST http://127.0.0.1:9004/schedule \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sofascore-monitor-2026' \
  -d '{"interval_hours":4}' || log "schedule API 跳过（监控未就绪）"

log "预热 Redis 缓存"
sudo docker compose -f docker-compose.core.yml exec -T server node -e \
  'require("./src/services/tennisLiveFromMonitor").refreshLiveBundleFromMonitor().then(b=>console.log("live",b.events)).catch(e=>{console.error(e.message);process.exit(1)})'
sudo docker compose -f docker-compose.core.yml exec -T server node -e \
  'require("./src/services/tennisNewFromMonitor").refreshNewBundleFromMonitor().then(b=>console.log("new",b.events)).catch(e=>{console.error(e.message);process.exit(1)})'

head="$(git -C "$SOURCE_DIR" rev-parse --short HEAD)"
log "部署完成 @ ${head} $(git -C "$SOURCE_DIR" log -1 --format='%s')"
curl -sf http://127.0.0.1:9004/health && echo
sudo docker compose -f docker-compose.core.yml ps
