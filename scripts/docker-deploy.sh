#!/usr/bin/env bash
# 用法:
#   bash scripts/docker-deploy.sh test up -d --build
#   bash scripts/docker-deploy.sh prod up -d --build
#   bash scripts/docker-deploy.sh test ps
#   bash scripts/docker-deploy.sh prod logs -f server
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_NAME="${1:-}"
shift || true
if [[ "$ENV_NAME" != "test" && "$ENV_NAME" != "prod" ]]; then
  echo "usage: $0 test|prod <compose-args...>"
  echo "  e.g. $0 test up -d --build"
  echo "       $0 prod ps"
  exit 1
fi

ENV_FILE="deploy/${ENV_NAME}.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE"
  exit 1
fi

# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

echo "==> env=$ENV_NAME project=${COMPOSE_PROJECT_NAME:-?} web=${WEB_PORT:-?} board=${BOARD_PORT:-?} profiles=${COMPOSE_PROFILES:-none} env_file=${SERVER_ENV_FILE:-./server/.env}"
exec docker compose --env-file "$ENV_FILE" -f docker-compose.core.yml "$@"
