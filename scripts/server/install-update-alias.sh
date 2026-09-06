#!/usr/bin/env bash
# 在服务器安装 yuce-update / yuce-deploy 快捷命令（一次性）
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
sudo cp "$SRC/scripts/server/update-sourcecode.sh" /opt/yuce/update-sourcecode.sh
sudo cp "$SRC/scripts/server/deploy-from-sourcecode.sh" /opt/yuce/deploy-from-sourcecode.sh
sudo chmod +x /opt/yuce/update-sourcecode.sh /opt/yuce/deploy-from-sourcecode.sh
grep -q 'yuce-deploy' "$HOME/.bashrc" 2>/dev/null || cat >> "$HOME/.bashrc" <<'EOF'

# YUCE deploy
alias yuce-update='bash /opt/yuce/update-sourcecode.sh'
alias yuce-deploy='bash /opt/yuce/deploy-from-sourcecode.sh'
EOF
echo "已安装: yuce-update / yuce-deploy"
