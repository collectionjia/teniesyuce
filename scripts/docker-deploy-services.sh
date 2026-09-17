#!/usr/bin/env bash
# 五引擎服务 compose（与 docker-compose.core.yml 分开部署，server 经 SCHEDULER_URL 连接）
#   bash scripts/docker-deploy-services.sh up -d --build
#   bash scripts/docker-deploy-services.sh ps
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE="${COMPOSE_SERVICES_PROFILE:-all}"
echo "==> services profile=$PROFILE"
exec docker compose -f deploy/docker-compose.services.yml --profile "$PROFILE" "$@"
