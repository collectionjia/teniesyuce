#!/usr/bin/env bash
# 五引擎跑在宿主机（9101–9105），server Docker 经 host.docker.internal 访问
# 测试: SERVER_ENV_FILE=server/.env.test  生产: SERVER_ENV_FILE=server/.env
#   bash scripts/deploy-host-services.sh restart
#   bash scripts/deploy-host-services.sh stop
#   bash scripts/deploy-host-services.sh status
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${SERVER_ENV_FILE:-$ROOT/server/.env.test}"
LOG_DIR="${YUCE_LOG_DIR:-$ROOT/logs/services}"
ACTION="${1:-restart}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE"
  echo "  test: bash scripts/init-env-test.sh"
  echo "  prod: cp server/.env.example server/.env && bash scripts/init-env-prod-docker.sh"
  exit 1
fi

mkdir -p "$LOG_DIR"

declare -A PORTS=(
  [collect]=9101
  [rules]=9102
  [betting]=9103
  [stop-loss]=9104
  [scheduler]=9105
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
    # 宿主机进程：直连本机 MySQL / Redis
    export DB_HOST="${DB_HOST_HOST:-127.0.0.1}"
    export DB_PORT="${DB_PORT_HOST:-3306}"
    export REDIS_URL="${REDIS_URL_HOST:-redis://127.0.0.1:${REDIS_HOST_PORT:-9015}}"
    if [[ "$name" == scheduler ]]; then
      export EXECUTOR_MODE=http
      export COLLECT_URL=http://127.0.0.1:9101
      export RULES_URL=http://127.0.0.1:9102
      export BETTING_URL=http://127.0.0.1:9103
      export STOP_LOSS_URL=http://127.0.0.1:9104
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
