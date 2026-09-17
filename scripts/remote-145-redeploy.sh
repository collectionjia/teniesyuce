#!/usr/bin/env bash
set -euo pipefail
ROOT="/opt/yuce/teniesyuce"
cd "$ROOT"

echo "==> recreate server/.env from old container (if missing)"
if [[ ! -f server/.env ]] && docker inspect yuce-server-1 >/dev/null 2>&1; then
  docker inspect yuce-server-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -E '^(DB_|JWT_|APP_|ALCHEMY|CRAWL|FILTER|WEB_PORT|TENNIS_CACHE|MUSKPAY|SOFA_MONITOR_TOKEN|INIT_)' \
    > server/.env || true
  {
    echo 'REDIS_URL=redis://redis:6379'
    echo 'SOFA_MONITOR_URL=http://host.docker.internal:9004'
    echo 'SCHEDULER_URL=http://host.docker.internal:9105'
    echo 'COLLECT_URL=http://host.docker.internal:9101'
    echo 'RULES_URL=http://host.docker.internal:9102'
    echo 'BETTING_URL=http://host.docker.internal:9103'
    echo 'STOP_LOSS_URL=http://host.docker.internal:9104'
    echo 'SCHEDULER_LOOP_ENABLED=1'
  } >> server/.env
  chmod 600 server/.env
  echo "created server/.env"
elif [[ ! -f server/.env ]]; then
  cp server/.env.example server/.env
  bash scripts/init-env-prod-docker.sh
  echo "created server/.env from example — 请检查 DB_PASSWORD"
fi

echo "==> git pull"
git pull origin main

echo "==> stop host services"
chmod +x scripts/*.sh
bash scripts/deploy-host-services.sh stop 2>/dev/null || true

echo "==> down compose + stop all containers"
bash scripts/docker-deploy.sh prod down 2>/dev/null || true
bash scripts/docker-deploy.sh test down 2>/dev/null || true
docker compose -f deploy/docker-compose.services.yml --profile all down 2>/dev/null || true
ids=$(docker ps -q || true)
if [[ -n "$ids" ]]; then docker stop $ids; fi

echo "==> prod deploy"
bash scripts/docker-deploy-prod-all.sh

echo "==> verify"
curl -sf "http://127.0.0.1:9001/api/health" && echo " health ok"
bash scripts/deploy-host-services.sh status || true
