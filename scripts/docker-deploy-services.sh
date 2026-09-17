#!/usr/bin/env bash
# 五引擎服务 compose（与 docker-compose.core.yml 分开部署，server 经 SCHEDULER_URL 连接）
#   bash scripts/docker-deploy-services.sh up -d --build
#   bash scripts/docker-deploy-services.sh ps
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE="${COMPOSE_SERVICES_PROFILE:-all}"
echo "==> services profile=$PROFILE (compose: deploy/docker-compose.services.yml)"
if [[ ! -f server/.env ]]; then
  echo "missing server/.env"
  exit 1
fi
if [[ ! -d server/node_modules ]]; then
  echo "hint: npm install --omit=dev --prefix server"
fi
exec docker compose -f deploy/docker-compose.services.yml --profile "$PROFILE" "$@"
