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

# up 前释放宿主机 9101–9105，避免与旧 host 引擎抢端口（尤其 scheduler:9105）
if [[ "${1:-}" == "up" ]]; then
  if [[ -x "$ROOT/scripts/deploy-host-services.sh" ]]; then
    bash "$ROOT/scripts/deploy-host-services.sh" stop 2>/dev/null || true
  fi
  for port in 9101 9102 9103 9104 9105; do
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${port}/tcp" 2>/dev/null || true
    elif command -v ss >/dev/null 2>&1; then
      pids="$(ss -lntp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print}' | grep -oP 'pid=\K[0-9]+' || true)"
      for pid in $pids; do kill "$pid" 2>/dev/null || true; done
    fi
  done
fi

exec docker compose -f deploy/docker-compose.services.yml --profile "$PROFILE" "$@"
