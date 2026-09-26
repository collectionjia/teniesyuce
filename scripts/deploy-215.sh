#!/usr/bin/env bash
# 46.250.163.215 测试一键部署
# 手动: bash scripts/deploy-215.sh [--no-cache]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> [deploy-215] $(date -Iseconds) root=$ROOT"

echo "==> git pull --ff-only"
git pull --ff-only

echo "==> docker-deploy-test-all"
bash scripts/docker-deploy-test-all.sh "${@:-}"

echo "==> [deploy-215] done"
