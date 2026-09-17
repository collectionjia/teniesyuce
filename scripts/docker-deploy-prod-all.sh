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

echo "==> [2/4] 停掉宿主机五引擎（若曾 npm 启动）"
bash scripts/deploy-host-services.sh stop 2>/dev/null || true

echo "==> [3/4] server node_modules（供容器 NODE_PATH 挂载）"
if [[ ! -d server/node_modules ]]; then
  npm install --omit=dev --prefix server
fi

echo "==> [4/4] Docker 五引擎 (9101-9105, 接入 yuce-prod 网络 Redis)"
bash scripts/docker-deploy-services.sh up -d --build "${EXTRA[@]}"

echo "==> 健康检查"
sleep 6
curl -sf "http://127.0.0.1:${WEB_PORT:-9001}/api/health" && echo "  web :${WEB_PORT:-9001} ok" || echo "  web :${WEB_PORT:-9001} FAIL"
for p in 9101 9102 9103 9104 9105; do
  curl -sf "http://127.0.0.1:${p}/health" >/dev/null && echo "  engine :${p} ok" || echo "  engine :${p} FAIL"
done
bash scripts/docker-deploy-services.sh ps

echo ""
echo "生产: http://127.0.0.1:${WEB_PORT:-9001}/ (对外域名见 APP_PUBLIC_URL)"
echo "五引擎: bash scripts/docker-deploy-services.sh logs -f scheduler"
