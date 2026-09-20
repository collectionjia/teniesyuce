#!/usr/bin/env bash
# scripts/release.sh — 语义化版本发布脚本
#
# 用法：
#   ./scripts/release.sh patch    # 0.0.X  修 bug
#   ./scripts/release.sh minor    # 0.X.0  加功能
#   ./scripts/release.sh major    # X.0.0  破坏性变更
#   ./scripts/release.sh 1.2.3    # 指定版本
#
# 流程：
#   1. 跑 sanity check（git 干净、当前在 main）
#   2. 切到 develop → merge → bump version → CHANGELOG
#   3. 切回 main → fast-forward merge → tag → push
#
# 依赖：git, sed, awk

set -euo pipefail

BUMP_TYPE="${1:-}"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

die() { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
ok()  { echo -e "${GREEN}✅ $1${NC}"; }
warn(){ echo -e "${YELLOW}⚠️  $1${NC}"; }

# 1. Sanity
[ -z "$BUMP_TYPE" ] && die "Usage: $0 {patch|minor|major|X.Y.Z}"
[[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "develop" ]] \
  && die "Must be on main or develop branch (currently: $CURRENT_BRANCH)"
[ -n "$(git status --porcelain)" ] && die "Working tree is dirty. Commit/stash first."

# 2. 读当前版本
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
CURRENT_VERSION="${LAST_TAG#v}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
ok "Current version: $LAST_TAG"

# 3. 计算新版本
case "$BUMP_TYPE" in
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH+1))" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR+1)).0" ;;
  major) NEW_VERSION="$((MAJOR+1)).0.0" ;;
  *)
    [[ "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || die "Invalid version: $BUMP_TYPE (use patch/minor/major/X.Y.Z)"
    NEW_VERSION="$BUMP_TYPE"
    ;;
esac
NEW_TAG="v$NEW_VERSION"
ok "New version:     $NEW_TAG"

# 4. 提示输入 CHANGELOG
echo ""
echo "📝 Enter release notes (Ctrl-D to finish):"
echo "---"
NOTES=$(cat)
[ -z "$NOTES" ] && die "Release notes cannot be empty"
echo "---"

# 5. 切换分支、merge
START_BRANCH="$CURRENT_BRANCH"
if [ "$CURRENT_BRANCH" = "develop" ]; then
  warn "Switching to main, fast-forwarding from develop..."
  git checkout main
  git merge --ff-only develop
fi

# 6. 更新 CHANGELOG
DATE=$(date +%Y-%m-%d)
TEMP=$(mktemp)
cat > "$TEMP" <<EOF
# 变更日志

## ${NEW_TAG} (${DATE})

${NOTES}

EOF
cat CHANGELOG.md >> "$TEMP"
mv "$TEMP" CHANGELOG.md
ok "CHANGELOG.md updated"

# 7. 提交 + tag
git add CHANGELOG.md
git commit -m "Release ${NEW_TAG}"
git tag -a "$NEW_TAG" -m "${NEW_TAG}

${NOTES}"
ok "Tag created: $NEW_TAG"

# 8. 回到 develop
if [ "$START_BRANCH" = "develop" ]; then
  git checkout develop
  git merge --ff-only main
fi

# 9. 提示 push
echo ""
ok "Release ready: $NEW_TAG"
echo ""
echo "Next steps:"
echo "  git push origin main develop --tags"
