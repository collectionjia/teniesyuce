#!/usr/bin/env bash
# 只重建 / 重启：web（前端）+ dota2elo（Dota2 产品页）
#
# 用法（在项目根目录）:
#   bash scripts/deploy-web-dota2.sh prod              # pull 后无缓存重建并 up
#   bash scripts/deploy-web-dota2.sh test
#   bash scripts/deploy-web-dota2.sh prod --skip-pull  # 代码已更新，只重建
#   bash scripts/deploy-web-dota2.sh prod --cache      # 允许 docker 层缓存（更快）
#   bash scripts/deploy-web-dota2.sh prod --ps         # 只看状态
#   bash scripts/deploy-web-dota2.sh prod --logs       # 跟日志
#
# 等价手写:
#   bash scripts/docker-deploy.sh prod up -d --build --force-recreate --no-deps web dota2elo
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_NAME="${1:-}"
shift || true
if [[ "$ENV_NAME" != "test" && "$ENV_NAME" != "prod" ]]; then
  echo "usage: $0 test|prod [--skip-pull] [--cache] [--ps] [--logs]"
  exit 1
fi

SKIP_PULL=""
NO_CACHE="--no-cache"
ONLY_PS=""
ONLY_LOGS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull) SKIP_PULL=1 ;;
    --cache) NO_CACHE="" ;;
    --ps) ONLY_PS=1 ;;
    --logs) ONLY_LOGS=1 ;;
    *)
      echo "unknown arg: $1"
      exit 1
      ;;
  esac
  shift
done

if [[ -n "$ONLY_PS" ]]; then
  bash scripts/docker-deploy.sh "$ENV_NAME" ps web dota2elo
  exit 0
fi

if [[ -n "$ONLY_LOGS" ]]; then
  bash scripts/docker-deploy.sh "$ENV_NAME" logs -f --tail=80 web dota2elo
  exit 0
fi

echo "==> [1/3] 更新代码 ($ENV_NAME)"
if [[ -n "$SKIP_PULL" ]]; then
  echo "    已跳过 git pull"
elif git pull --ff-only; then
  echo "    git pull 完成"
else
  echo "    git pull 失败；可用 --skip-pull 跳过，或先处理本地改动"
  exit 1
fi

echo "==> [2/3] 构建 web + dota2elo"
# shellcheck disable=SC2086
bash scripts/docker-deploy.sh "$ENV_NAME" build $NO_CACHE web dota2elo

echo "==> [3/3] 重启 web + dota2elo（不牵动 server/redis）"
bash scripts/docker-deploy.sh "$ENV_NAME" up -d --force-recreate --no-deps web dota2elo

echo "==> 完成"
bash scripts/docker-deploy.sh "$ENV_NAME" ps web dota2elo
echo
echo "提示: 前端走 WEB_PORT；Dota2 iframe 走容器内网 DOTA2ELO_PRODUCT_URL=http://dota2elo:3001/"
