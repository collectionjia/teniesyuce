#!/usr/bin/env bash
# 生成 server/.env.test：MySQL/Redis 指向 215 宿主机本机（非公网 IP）
#   bash scripts/init-env-test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="$ROOT/server/.env.test"
SRC="$ROOT/server/.env"
EXAMPLE="$ROOT/server/.env.test.example"

if [[ -f "$TARGET" ]]; then
  echo "exists: $TARGET (skip; delete to regenerate)"
  exit 0
fi

if [[ -f "$SRC" ]]; then
  cp "$SRC" "$TARGET"
  echo "copied from server/.env"
elif [[ -f "$EXAMPLE" ]]; then
  cp "$EXAMPLE" "$TARGET"
  echo "copied from server/.env.test.example — 请编辑 DB_PASSWORD / JWT_SECRET"
else
  echo "missing server/.env and server/.env.test.example"
  exit 1
fi

# Docker 测试栈：容器 → 宿主机 MySQL / Redis
patch() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$TARGET"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$TARGET"
  else
    echo "${key}=${val}" >> "$TARGET"
  fi
}

patch DB_HOST host.docker.internal
patch DB_PORT 3306
patch REDIS_URL redis://host.docker.internal:9015
patch REDIS_PORT 9015
patch SCHEDULER_URL http://host.docker.internal:9105
patch COLLECT_URL http://host.docker.internal:9101
patch RULES_URL http://host.docker.internal:9102
patch BETTING_URL http://host.docker.internal:9103
patch STOP_LOSS_URL http://host.docker.internal:9104
patch SOFA_MONITOR_URL http://host.docker.internal:9004
patch APP_FRONTEND_URL http://46.250.163.215:9018
patch APP_PUBLIC_URL http://46.250.163.215:9018
patch WEB_PORT 9018

echo "ok: $TARGET (本机 MySQL:3306 Redis:9015 via host.docker.internal)"
