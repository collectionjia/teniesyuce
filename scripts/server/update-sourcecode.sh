#!/usr/bin/env bash
# 在服务器 /opt/yuce/sourcecode 从 GitHub 拉取最新代码
# 用法:
#   bash /opt/yuce/update-sourcecode.sh          # 更新
#   bash /opt/yuce/update-sourcecode.sh --setup # 首次：生成 deploy key 提示
#   bash /opt/yuce/update-sourcecode.sh --status

set -euo pipefail

REPO_URL="${YUCE_REPO_URL:-git@github.com:collectionjia/yuce.git}"
TARGET_DIR="${YUCE_SOURCE_DIR:-/opt/yuce/sourcecode}"
BRANCH="${YUCE_GIT_BRANCH:-main}"
DEPLOY_KEY="${YUCE_GITHUB_DEPLOY_KEY:-$HOME/.ssh/id_ed25519_github_deploy}"
LOG_TAG="[yuce-update]"

usage() {
  cat <<EOF
用法: $(basename "$0") [--setup|--status|--help]

  (无参数)   fetch + pull 更新 ${TARGET_DIR}
  --setup    生成 GitHub Deploy Key 并写入 ssh config（需到 GitHub 添加公钥）
  --status   显示目录与 git 状态
  --help     显示本帮助

环境变量:
  YUCE_REPO_URL              默认 git@github.com:collectionjia/yuce.git
  YUCE_SOURCE_DIR            默认 /opt/yuce/sourcecode
  YUCE_GIT_BRANCH            默认 main
  YUCE_GITHUB_DEPLOY_KEY     默认 ~/.ssh/id_ed25519_github_deploy
EOF
}

log() { echo "${LOG_TAG} $*"; }
die() { echo "${LOG_TAG} ERROR: $*" >&2; exit 1; }

ensure_ssh() {
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true

  if [[ ! -f "$DEPLOY_KEY" ]]; then
    log "生成 Deploy Key: ${DEPLOY_KEY}"
    ssh-keygen -t ed25519 -f "$DEPLOY_KEY" -N "" -C "yuce-server-deploy"
    echo
    echo "========== 请把下面公钥加到 GitHub =========="
    echo "仓库: https://github.com/collectionjia/yuce/settings/keys"
    echo "Deploy keys → Add deploy key → 只读即可"
    echo
    cat "${DEPLOY_KEY}.pub"
    echo "============================================="
    die "添加公钥后重新运行: bash $0"
  fi

  local cfg="$HOME/.ssh/config"
  if ! grep -q "Host github.com" "$cfg" 2>/dev/null; then
    cat >> "$cfg" <<EOF

Host github.com
  HostName github.com
  User git
  IdentityFile ${DEPLOY_KEY}
  IdentitiesOnly yes
EOF
    chmod 600 "$cfg"
    log "已写入 ~/.ssh/config"
  fi

  local gh_msg
  gh_msg="$(ssh -T git@github.com 2>&1)" || true
  if ! grep -qi "successfully authenticated" <<< "$gh_msg"; then
    echo
    log "GitHub 尚未授权，请添加 Deploy Key:"
    cat "${DEPLOY_KEY}.pub"
    die "GitHub SSH 未就绪"
  fi
}

cmd_setup() {
  ensure_ssh
  log "GitHub SSH 已就绪"
  if [[ -d "${TARGET_DIR}/.git" ]]; then
    log "仓库已存在: ${TARGET_DIR}"
  else
    log "下一步可运行: bash $0"
  fi
}

cmd_status() {
  log "目录: ${TARGET_DIR}"
  log "远程: ${REPO_URL}  分支: ${BRANCH}"
  if [[ -d "${TARGET_DIR}/.git" ]]; then
    git -C "$TARGET_DIR" remote -v
    git -C "$TARGET_DIR" status -sb
    git -C "$TARGET_DIR" log -1 --oneline
  else
    log "尚未 clone（目录为空或无 .git）"
  fi
}

cmd_update() {
  ensure_ssh
  mkdir -p "$(dirname "$TARGET_DIR")"

  if [[ ! -d "${TARGET_DIR}/.git" ]]; then
    log "首次 clone → ${TARGET_DIR}"
    rm -rf "${TARGET_DIR}"
    git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
  else
    log "pull ${BRANCH} @ ${TARGET_DIR}"
    git -C "$TARGET_DIR" fetch origin "$BRANCH"
    git -C "$TARGET_DIR" checkout "$BRANCH"
    git -C "$TARGET_DIR" pull --ff-only origin "$BRANCH"
  fi

  local head
  head="$(git -C "$TARGET_DIR" rev-parse --short HEAD)"
  log "完成 @ ${head} $(git -C "$TARGET_DIR" log -1 --format='%s')"
}

main() {
  case "${1:-}" in
    --setup)  cmd_setup ;;
    --status) cmd_status ;;
    --help|-h) usage ;;
    "")       cmd_update ;;
    *)        usage; die "未知参数: $1" ;;
  esac
}

main "$@"
