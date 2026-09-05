#!/usr/bin/env bash
# =============================================================================
# YUCE 项目 — 服务器端一键部署脚本
#
# 适用：Lightsail / Ubuntu，在「网页 SSH 终端」或已放行的 SSH 里执行。
#
# 首次部署（全新机器）：
#   curl -fsSL https://raw.githubusercontent.com/collectionjia/yuce/main/scripts/deploy-server.sh -o /tmp/deploy-server.sh
#   bash /tmp/deploy-server.sh --init
#
# 或仓库已在 /opt/yuce/bbbbb：
#   cd /opt/yuce/bbbbb && bash scripts/deploy-server.sh
#
# 常用：
#   bash scripts/deploy-server.sh              # 拉代码 + 构建 + 启动（核心服务）
#   bash scripts/deploy-server.sh --web-only   # 只重建前端
#   bash scripts/deploy-server.sh --all        # 含 basketball / dota2
#   bash scripts/deploy-server.sh --no-cache   # 强制无缓存构建
#   bash scripts/deploy-server.sh --status     # 查看状态
#   bash scripts/deploy-server.sh --logs web   # 查看 web 日志
# =============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/yuce/bbbbb}"
REPO_URL="${REPO_URL:-https://github.com/collectionjia/yuce.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core.yml}"
WEB_PORT="${WEB_PORT:-9001}"
NO_CACHE=""
DO_PULL=1
DO_BUILD=1
DO_UP=1
INIT_MODE=0
WEB_ONLY=0
ALL_SERVICES=0
ACTION="deploy"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \?//'
  echo ""
  echo "选项:"
  echo "  --init          首次安装：clone 目录、检查 .env、安装 docker"
  echo "  --pull          仅 git pull"
  echo "  --build         仅 docker compose build"
  echo "  --up            仅 docker compose up -d"
  echo "  --restart       up -d --force-recreate"
  echo "  --web-only      只构建/重启 web 容器"
  echo "  --all           使用 docker-compose.external.yml（含 NBA/DOTA2）"
  echo "  --no-cache      build 时不使用缓存"
  echo "  --no-pull       跳过 git pull"
  echo "  --status        docker ps + health"
  echo "  --logs [svc]    跟踪日志（默认 server）"
  echo "  -h, --help      帮助"
  exit 0
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi
  log "安装 Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" 2>/dev/null || true
  need_cmd docker
}

ensure_env() {
  local env_file="$INSTALL_DIR/server/.env"
  if [[ -f "$env_file" ]]; then
    log "已存在 $env_file"
    return 0
  fi
  if [[ -f "$INSTALL_DIR/server/.env.example" ]]; then
    cp "$INSTALL_DIR/server/.env.example" "$env_file"
    die "已生成 $env_file ，请编辑数据库/密钥后重新运行"
  fi
  die "缺少 server/.env，请从 server/.env.example 复制并填写"
}

clone_or_update() {
  if [[ ! -d "$INSTALL_DIR/.git" ]]; then
    log "克隆仓库 -> $INSTALL_DIR"
    sudo mkdir -p "$(dirname "$INSTALL_DIR")"
    if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
      die "目录 $INSTALL_DIR 已存在且非空，请清空或改 INSTALL_DIR"
    fi
    sudo git clone --branch "$GIT_BRANCH" "$REPO_URL" "$INSTALL_DIR"
    sudo chown -R "$USER:$USER" "$INSTALL_DIR"
  elif [[ "$DO_PULL" -eq 1 ]]; then
    log "git pull ($GIT_BRANCH)"
    cd "$INSTALL_DIR"
    git fetch origin "$GIT_BRANCH"
    git checkout "$GIT_BRANCH"
    git pull --ff-only origin "$GIT_BRANCH"
  fi
}

compose() {
  cd "$INSTALL_DIR"
  export WEB_PORT
  docker compose -f "$COMPOSE_FILE" "$@"
}

cmd_init() {
  need_cmd git
  ensure_docker
  clone_or_update
  ensure_env
  log "初始化完成。请编辑 server/.env 后执行: bash scripts/deploy-server.sh"
}

cmd_build() {
  cd "$INSTALL_DIR"
  ensure_env
  local services=()
  if [[ "$WEB_ONLY" -eq 1 ]]; then
    services=(web)
  elif [[ "$ALL_SERVICES" -eq 1 ]]; then
    services=()
  else
    services=(redis board server web)
  fi
  local args=(build)
  [[ -n "$NO_CACHE" ]] && args+=(--no-cache)
  [[ ${#services[@]} -gt 0 ]] && args+=("${services[@]}")
  log "docker compose -f $COMPOSE_FILE build ${services[*]:-(all)}"
  compose "${args[@]}"
}

cmd_up() {
  cd "$INSTALL_DIR"
  ensure_env
  local args=(up -d)
  [[ "$1" == "restart" ]] && args+=(--force-recreate)
  if [[ "$WEB_ONLY" -eq 1 ]]; then
    args+=(web)
  fi
  log "docker compose -f $COMPOSE_FILE ${args[*]}"
  compose "${args[@]}"
}

cmd_status() {
  cd "$INSTALL_DIR"
  compose ps
  echo ""
  log "HTTP 探测 (web -> :$WEB_PORT)"
  curl -fsS -m 5 "http://127.0.0.1:${WEB_PORT}/" >/dev/null && echo "  web: OK" || echo "  web: FAIL"
  curl -fsS -m 5 "http://127.0.0.1:${WEB_PORT}/api/health" && echo "" || echo "  api: FAIL"
  curl -fsS -m 5 "http://127.0.0.1:${BOARD_PORT:-8890}/api/state" >/dev/null && echo "  board: OK" || echo "  board: FAIL (可选)"
}

cmd_logs() {
  local svc="${1:-server}"
  cd "$INSTALL_DIR"
  compose logs -f --tail=200 "$svc"
}

# ---------- 解析参数 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --init) INIT_MODE=1; ACTION=init ;;
    --pull) ACTION=pull; DO_BUILD=0; DO_UP=0 ;;
    --build) ACTION=build; DO_PULL=0; DO_UP=0 ;;
    --up) ACTION=up; DO_PULL=0; DO_BUILD=0 ;;
    --restart) ACTION=restart; DO_PULL=1 ;;
    --web-only) WEB_ONLY=1 ;;
    --all) ALL_SERVICES=1; COMPOSE_FILE=docker-compose.external.yml ;;
    --no-cache) NO_CACHE=1 ;;
    --no-pull) DO_PULL=0 ;;
    --status) ACTION=status ;;
    --logs) ACTION=logs; shift; LOG_SVC="${1:-server}"; break ;;
    -h|--help) usage ;;
    *) die "未知参数: $1（用 --help 查看）" ;;
  esac
  shift
done

# ---------- 执行 ----------
case "$ACTION" in
  init)
    cmd_init
    ;;
  pull)
    clone_or_update
    ;;
  build)
    ensure_docker
    clone_or_update
    cmd_build
    ;;
  up)
    ensure_docker
    cmd_up
    ;;
  restart)
    ensure_docker
    clone_or_update
    cmd_build
    cmd_up restart
    cmd_status
    ;;
  status)
    cmd_status
    ;;
  logs)
    cmd_logs "${LOG_SVC:-server}"
    ;;
  deploy)
    ensure_docker
    clone_or_update
    ensure_env
    if [[ "$DO_BUILD" -eq 1 ]]; then cmd_build; fi
    if [[ "$DO_UP" -eq 1 ]]; then cmd_up; fi
    cmd_status
    log "完成。站点: http://$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || echo 'YOUR_IP'):${WEB_PORT}/"
    ;;
esac
