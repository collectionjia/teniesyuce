#!/usr/bin/env bash
# 215 测试环境一键发布：core Docker(test) + 宿主机五引擎
#   bash scripts/docker-deploy-test-all.sh
#   bash scripts/docker-deploy-test-all.sh --no-cache
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXTRA=()
if [[ "${1:-}" == "--no-cache" ]]; then
  EXTRA+=(--no-cache)
fi

if [[ ! -f server/.env.test ]]; then
  bash scripts/init-env-test.sh
fi

echo "==> [1/3] Docker 测试栈 (web :9018)"
bash scripts/docker-deploy.sh test up -d --build "${EXTRA[@]}"

echo "==> [2/3] 宿主机五引擎 (9101-9105, 本机 MySQL/Redis)"
export SERVER_ENV_FILE="$ROOT/server/.env.test"
bash scripts/deploy-host-services.sh restart

echo "==> [3/3] 健康检查"
sleep 4
curl -sf "http://127.0.0.1:9018/api/health" && echo "  web :9018 ok" || echo "  web :9018 FAIL"
bash scripts/deploy-host-services.sh status

echo ""
echo "对外: http://46.250.163.215:9018/"
echo "日志: logs/services/*.log"
