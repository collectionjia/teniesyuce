#!/usr/bin/env bash
# WSL 本地：Docker Redis + server + btc-board + web
# 前置: server/.env 已配置 MySQL（可用远程 tennisv2）
# 用法（仓库根目录）: bash scripts/dev-wsl.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "请先安装并启动 Docker（WSL 内: sudo service docker start）" >&2
  exit 1
fi

if [[ ! -f server/.env ]]; then
  echo "缺少 server/.env，请先: cp server/.env.example server/.env 并填写 DB_*" >&2
  exit 1
fi

# 国内/WSL 常无法直连 docker.io，用镜像站拉取并 tag 成 compose 需要的名字
MIRROR="${DOCKER_MIRROR:-docker.1ms.run}"
pull_tag() {
  local name="$1"
  echo "==> pull $name (via $MIRROR)"
  if docker pull "$MIRROR/library/${name}" 2>/dev/null; then
    docker tag "$MIRROR/library/${name}" "$name"
  elif docker pull "$MIRROR/${name}" 2>/dev/null; then
    docker tag "$MIRROR/${name}" "$name"
  else
    echo "镜像拉取失败: $name（可设 DOCKER_MIRROR 或配置 /etc/docker/daemon.json registry-mirrors）" >&2
    return 1
  fi
}

echo "==> 拉取基础镜像..."
pull_tag node:20-alpine
pull_tag nginx:1.27-alpine
pull_tag python:3.12-slim

echo "==> docker compose up (yuce: remote redis + btc-board + server + web)"
docker compose -f docker-compose.core.yml -f docker-compose.wsl.yml up -d --build

echo ""
echo "==> 等待健康检查..."
sleep 8
docker compose -f docker-compose.core.yml -f docker-compose.wsl.yml ps

echo ""
echo "验收:"
echo "  网站    http://localhost:9001"
echo "  健康    curl -s http://localhost:9001/api/health"
echo "  Redis   redis-cli -h 46.250.163.215 -p 9015 ping"
echo "  BTC板   http://localhost:8890"
echo ""
echo "停止: docker compose -f docker-compose.core.yml -f docker-compose.wsl.yml down"
