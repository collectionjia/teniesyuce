#!/usr/bin/env bash
# 五引擎跑在宿主机（9101–9105），server Docker 经 host.docker.internal 访问
# 测试: SERVER_ENV_FILE=server/.env.test  生产: SERVER_ENV_FILE=server/.env.prod
#   bash scripts/deploy-host-services.sh restart
#   bash scripts/deploy-host-services.sh stop
#   bash scripts/deploy-host-services.sh status
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${SERVER_ENV_FILE:-$ROOT/server/.env}"
LOG_DIR="${YUCE_LOG_DIR:-$ROOT/logs/services}"
ACTION="${1:-restart}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE"
  echo "  test: bash scripts/init-env-test.sh"
  echo "  prod: cp server/.env.example server/.env && bash scripts/init-env-prod-docker.sh"
  exit 1
fi

mkdir -p "$LOG_DIR"

# 测试环境 Redis 常占用宿主机 9101，可设 COLLECT_HOST_PORT=9111 避开
# 测试环境若有容器占用 9105，可设 SCHEDULER_HOST_PORT=9115
COLLECT_PORT="${COLLECT_HOST_PORT:-9101}"
SCHEDULER_PORT="${SCHEDULER_HOST_PORT:-9105}"
declare -A PORTS=(
  [collect]="$COLLECT_PORT"
  [rules]=9102
  [betting]=9103
  [stop-loss]=9104
  [scheduler]="$SCHEDULER_PORT"
)

pid_file() { echo "$LOG_DIR/$1.pid"; }

stop_one() {
  local name="$1"
  local pf
  pf="$(pid_file "$name")"
  if [[ -f "$pf" ]]; then
    local pid
    pid="$(cat "$pf" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pf"
  fi
  local port="${PORTS[$name]}"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi
}

stop_all() {
  for name in scheduler stop-loss betting rules collect; do
    stop_one "$name"
  done
}

start_one() {
  local name="$1"
  local port="${PORTS[$name]}"
  local dir="$ROOT/services/$name"
  if [[ ! -d "$dir" ]]; then
    echo "missing $dir"
    exit 1
  fi
  if [[ ! -d "$dir/node_modules" ]]; then
    echo "npm install $name..."
    (cd "$dir" && npm install --omit=dev)
  fi
  stop_one "$name"
  (
    cd "$dir"
    export ENV_FILE="$ENV_FILE"
    export SERVER_ROOT="$ROOT/server"
    export PORT="$port"
    # serverBridge 会 require server/src/services/*，需能解析到 server 的依赖
    export NODE_PATH="$ROOT/server/node_modules${NODE_PATH:+:$NODE_PATH}"
    # 宿主机：仅显式设置时覆盖（145 外部 MySQL 等走 ENV_FILE；Redis 生产常设 REDIS_URL_HOST）
    if [[ -n "${DB_HOST_HOST:-}" ]]; then export DB_HOST="$DB_HOST_HOST"; fi
    if [[ -n "${DB_PORT_HOST:-}" ]]; then export DB_PORT="$DB_PORT_HOST"; fi
    if [[ -n "${REDIS_URL_HOST:-}" ]]; then export REDIS_URL="$REDIS_URL_HOST"; fi
    if [[ "$name" == scheduler ]]; then
      export EXECUTOR_MODE=http
      export COLLECT_URL="http://127.0.0.1:${COLLECT_PORT}"
      export RULES_URL=http://127.0.0.1:9102
      export BETTING_URL=http://127.0.0.1:9103
      export STOP_LOSS_URL=http://127.0.0.1:9104
    fi
    # 宿主机进程不能解析 compose 服务名，Elo 走本机映射端口
    if [[ "$name" == collect || "$name" == scheduler ]]; then
      export DOTA2ELO_URL="http://127.0.0.1:${DOTA2ELO_HOST_PORT:-8893}"
      export DOTA2ELO_PRODUCT_URL="$DOTA2ELO_URL/"
      export NFLELO_URL="http://127.0.0.1:${NFLELO_HOST_PORT:-8894}"
    fi
    nohup npm run dev >> "$LOG_DIR/$name.log" 2>&1 &
    echo $! > "$(pid_file "$name")"
  )
  echo "started $name :$port pid=$(cat "$(pid_file "$name")")"
}

start_all() {
  for name in collect rules betting stop-loss scheduler; do
    start_one "$name"
    sleep 1
  done
}

status_all() {
  for name in collect rules betting stop-loss scheduler; do
    local port="${PORTS[$name]}"
    local pf pid state="down"
    pf="$(pid_file "$name")"
    if [[ -f "$pf" ]]; then
      pid="$(cat "$pf" 2>/dev/null || true)"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        state="pid $pid"
      fi
    fi
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "  $name :$port health ok ($state)"
    else
      echo "  $name :$port health FAIL ($state)"
    fi
  done
}

case "$ACTION" in
  start) start_all ;;
  stop) stop_all ;;
  restart) stop_all; sleep 1; start_all ;;
  status) status_all ;;
  *)
    echo "usage: $0 start|stop|restart|status"
    exit 1
    ;;
esac
