#!/usr/bin/env bash
# scripts/gitflow.sh — git flow 速查 / 工具
#
# 用法：
#   ./scripts/gitflow.sh status    # 当前状态
#   ./scripts/gitflow.sh new-feat <name>   # 开 feature 分支
#   ./scripts/gitflow.sh new-fix <name>    # 开 bugfix 分支
#   ./scripts/gitflow.sh finish           # 把当前 feature/* 合并回 develop
#   ./scripts/gitflow.sh hotfix <name>    # 紧急修复（main 直接出）
#   ./scripts/gitflow.sh log              # 漂亮的 git log
#   ./scripts/gitflow.sh tags             # 列出所有 tag + 简介

set -euo pipefail
CMD="${1:-}"
shift || true

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

die() { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
ok()  { echo -e "${GREEN}✅ $1${NC}"; }
info(){ echo -e "${BLUE}ℹ️  $1${NC}"; }

CURRENT=$(git rev-parse --abbrev-ref HEAD)

case "$CMD" in
  status)
    echo -e "${YELLOW}=== Git Status ===${NC}"
    echo "Branch: $CURRENT"
    echo "Last commit: $(git log -1 --oneline)"
    echo "Uncommitted changes: $(git status --porcelain | wc -l | tr -d ' ')"
    echo ""
    echo "Branches:"
    git branch -vv | head -20
    echo ""
    echo "Tags:"
    git tag -l --sort=-v:refname | head -5
    ;;

  new-feat)
    [ -z "${1:-}" ] && die "Usage: $0 new-feat <name>"
    NAME="feature/$1"
    [ "$CURRENT" != "develop" ] && die "Must be on develop to start feature"
    git checkout -b "$NAME"
    ok "Created: $NAME"
    ;;

  new-fix)
    [ -z "${1:-}" ] && die "Usage: $0 new-fix <name>"
    NAME="fix/$1"
    [ "$CURRENT" != "develop" ] && die "Must be on develop to start fix"
    git checkout -b "$NAME"
    ok "Created: $NAME"
    ;;

  finish)
    case "$CURRENT" in
      feature/*|fix/*)
        BRANCH_TYPE="${CURRENT%%/*}"
        BRANCH_NAME="${CURRENT#*/}"
        TARGET="${BRANCH_TYPE%e}"   # feature→develop, fix→develop
        [ "$BRANCH_TYPE" = "fix" ] && TARGET="develop" || TARGET="develop"
        info "Merging $CURRENT → $TARGET"
        git checkout "$TARGET"
        git merge --no-ff "$CURRENT" -m "Merge branch '$CURRENT' into $TARGET"
        git branch -d "$CURRENT"
        ok "Merged & deleted: $CURRENT"
        ;;
      *)
        die "Not on a feature/* or fix/* branch"
        ;;
    esac
    ;;

  hotfix)
    [ -z "${1:-}" ] && die "Usage: $0 hotfix <name>"
    [ "$CURRENT" != "main" ] && die "Must be on main to start hotfix"
    git checkout -b "hotfix/$1"
    ok "Created: hotfix/$1 (will merge back to main + develop)"
    ;;

  hotfix-finish)
    case "$CURRENT" in
      hotfix/*)
        info "Merging $CURRENT → main and develop"
        git checkout main
        git merge --no-ff "$CURRENT" -m "Merge hotfix '$CURRENT'"
        git checkout develop
        git merge --no-ff "$CURRENT" -m "Merge hotfix '$CURRENT'"
        git branch -d "$CURRENT"
        ok "Hotfix merged & deleted"
        ;;
      *)
        die "Not on a hotfix/* branch"
        ;;
    esac
    ;;

  log)
    git log --graph --pretty=format:'%C(yellow)%h%Creset -%C(red)%d%Creset %s %C(green)(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit -20
    ;;

  tags)
    echo -e "${YELLOW}=== Tags ===${NC}"
    git tag -l --sort=-v:refname | while read -r tag; do
      DATE=$(git log -1 --format="%ai" "$tag" | cut -d' ' -f1)
      MSG=$(git tag -l --format='%(contents:subject)' "$tag" | head -1)
      echo "  $tag  ($DATE)  $MSG"
    done
    ;;

  *)
    cat <<EOF
gitflow.sh — git flow 工具

用法:
  $0 status                    # 当前状态
  $0 new-feat <name>           # develop 上开 feature 分支
  $0 new-fix <name>            # develop 上开 fix 分支
  $0 finish                    # 把当前 feature/fix 合并回 develop
  $0 hotfix <name>             # main 上开 hotfix
  $0 hotfix-finish             # 把 hotfix 合并到 main + develop
  $0 log                       # 漂亮的 log
  $0 tags                      # 列出所有 tag

分支约定:
  main        - 生产分支，每个 tag 是一次发布
  develop     - 集成分支
  feature/*   - 新功能
  fix/*       - bug 修复
  hotfix/*    - 紧急修复（直接出 main）
EOF
    ;;
esac
