#!/usr/bin/env bash
# 95.40.57.145 生产一键部署（deploy-click :9009 调用）
# 手动: bash scripts/deploy-145.sh [--no-cache]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> [deploy-145] $(date -Iseconds) root=$ROOT"

echo "==> git pull --ff-only"
git pull --ff-only

echo "==> docker-deploy-prod-all"
bash scripts/docker-deploy-prod-all.sh "${@:-}"

echo "==> [deploy-145] done"
