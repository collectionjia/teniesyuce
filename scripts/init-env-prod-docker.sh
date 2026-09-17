#!/usr/bin/env bash
# 215 生产：确保 server/.env 适合 Docker 部署（本机 MySQL + compose Redis）
# 不覆盖密码/JWT，只改连接地址。可重复执行。
#   bash scripts/init-env-prod-docker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/server/.env"

if [[ ! -f "$TARGET" ]]; then
  echo "missing $TARGET"
  exit 1
fi

patch() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$TARGET"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$TARGET"
  else
    echo "${key}=${val}" >> "$TARGET"
  fi
}

# server 容器内由 deploy/prod.env 的 COMPOSE_* 再覆盖；此处写宿主机视角，供非 Docker 工具读取
patch DB_HOST host.docker.internal
patch DB_PORT 3306
patch SOFA_MONITOR_URL http://host.docker.internal:9004
patch SCHEDULER_URL http://host.docker.internal:9105
patch COLLECT_URL http://host.docker.internal:9101
patch RULES_URL http://host.docker.internal:9102
patch BETTING_URL http://host.docker.internal:9103
patch STOP_LOSS_URL http://host.docker.internal:9104

echo "ok: $TARGET patched for prod Docker (MySQL host.docker.internal:3306)"
echo "note: server 容器 Redis 用 compose 内 redis://redis:6379 (见 deploy/prod.env COMPOSE_REDIS_URL)"
echo "note: 五引擎宿主机 Redis 用 127.0.0.1:\${REDIS_HOST_PORT:-9016}"
