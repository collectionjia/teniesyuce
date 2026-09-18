#!/usr/bin/env bash
# 145 生产部署：代码更新后重新构建并启动整套服务
#
# 用法（在 145 服务器上）:
#   sudo bash scripts/deploy-145.sh            # pull + 重建 + 健康检查
#   sudo bash scripts/deploy-145.sh --skip-pull   # 代码已手动更新，只重建重启
#
# 说明:
#   · 核心栈 = docker-compose.core.yml (yuce-prod: server/web/redis/btc-board)，server 代码打进镜像，需 --build
#   · 五引擎 = deploy/docker-compose.services.yml (yuce-services: collect/rules/betting/stop-loss/scheduler)，
#     collect 镜像含 services/collect/src；server 代码与 scripts/tennis-monitor 经挂载实时生效
#   · tennis-monitor 采集已迁移到容器内（/tennis-monitor 挂载），宿主机 9004 systemd 无需再启动
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_PULL=""
if [[ "${1:-}" == "--skip-pull" ]]; then
  SKIP_PULL=1
fi

if [[ ! -f server/.env ]]; then
  echo "[deploy-145] 缺少 server/.env —— 先修复: cp server/.env.example server/.env && 填写密码"
  exit 1
fi

echo "==> [1/6] 更新代码"
if [[ -n "$SKIP_PULL" ]]; then
  echo "    已跳过 git pull"
elif git pull --ff-only origin main; then
  echo "    git pull 完成"
else
  echo "    git pull 失败（仓库里有未提交改动？）"
  echo "    · 若只是与即将拉入的提交冲突，见 git status 的冲突文件"
  echo "    · 可改用: sudo bash scripts/deploy-145.sh --skip-pull（自行同步代码后）"
  echo "    · 继续构建的风险自负"
fi

echo "==> [2/6] server 依赖 node_modules（五引擎容器 NODE_PATH 挂载用，缺 redis 会启动失败）"
if [[ ! -d server/node_modules/redis ]]; then
  echo "    server/node_modules 缺失或未装 redis，执行 npm install ..."
  npm install --omit=dev --prefix server
else
  echo "    server/node_modules 就绪"
fi

echo "==> [3/6] 重建核心栈 yuce-prod (server/web/redis/btc-board)"
bash scripts/docker-deploy.sh prod up -d --build

echo "==> [4/6] 重建五引擎 yuce-services (9101-9105)"
# 145 曾用宿主机 node 跑引擎；若 9105 仍被占，Docker scheduler 起不来 → server 对 scheduler ENOTFOUND → 调用中心 fetch failed
if [[ -x scripts/deploy-host-services.sh ]]; then
  bash scripts/deploy-host-services.sh stop 2>/dev/null || true
fi
bash scripts/docker-deploy-services.sh up -d --build

echo "==> [5/6] 健康检查"
sleep 6
# shellcheck disable=SC1091
source deploy/prod.env
WEB_PORT="${WEB_PORT:-9001}"
if curl -sf "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null; then
  echo "    web  :${WEB_PORT} ok"
else
  echo "    web  :${WEB_PORT} FAIL"
fi
for p in 9101 9102 9103 9104 9105; do
  if curl -sf "http://127.0.0.1:${p}/health" >/dev/null; then
    echo "    engine :${p} ok"
  else
    echo "    engine :${p} FAIL"
  fi
done

echo "==> [6/6] 服务状态"
bash scripts/docker-deploy.sh prod ps
docker compose -f deploy/docker-compose.services.yml --profile all ps

echo ""
echo "完成。线上入口: http://127.0.0.1:${WEB_PORT:-9001}/"
echo "看采集日志: docker logs -f yuce-services-collect-1"
echo "看 server 日志: docker logs -f yuce-prod-server-1"