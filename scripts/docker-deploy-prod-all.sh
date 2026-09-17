#!/usr/bin/env bash
# 215 生产环境一键发布：core Docker(prod) + 宿主机五引擎
#   bash scripts/docker-deploy-prod-all.sh
#   bash scripts/docker-deploy-prod-all.sh --no-cache
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXTRA=()
if [[ "${1:-}" == "--no-cache" ]]; then
  EXTRA+=(--no-cache)
fi

if [[ ! -f server/.env ]]; then
  echo "missing server/.env — 从 server/.env.example 复制并填写"
  exit 1
fi

# shellcheck disable=SC1091
source deploy/prod.env
REDIS_PORT="${REDIS_HOST_PORT:-9016}"

echo "==> [1/3] Docker 生产栈 (web :${WEB_PORT:-9001}, redis :${REDIS_PORT})"
bash scripts/docker-deploy.sh prod up -d --build "${EXTRA[@]}"

echo "==> [2/3] 宿主机五引擎 (9101-9105, 本机 MySQL + Redis:${REDIS_PORT})"
export SERVER_ENV_FILE="$ROOT/server/.env"
export REDIS_URL_HOST="redis://127.0.0.1:${REDIS_PORT}"
export DB_PORT_HOST="${DB_PORT_HOST:-3306}"
bash scripts/deploy-host-services.sh restart

echo "==> [3/3] 健康检查"
sleep 5
curl -sf "http://127.0.0.1:${WEB_PORT:-9001}/api/health" && echo "  web :${WEB_PORT:-9001} ok" || echo "  web :${WEB_PORT:-9001} FAIL"
curl -sf "http://127.0.0.1:${WEB_PORT:-9001}/api/admin/engines/overview" >/dev/null 2>&1 \
  && echo "  engines overview ok" || echo "  engines overview skip (需 admin JWT)"
bash scripts/deploy-host-services.sh status

echo ""
echo "生产: http://127.0.0.1:${WEB_PORT:-9001}/ (对外域名见 APP_PUBLIC_URL)"
echo "日志: logs/services/*.log"
