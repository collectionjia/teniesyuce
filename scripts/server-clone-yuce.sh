#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:collectionjia/yuce.git}"
TARGET_DIR="${TARGET_DIR:-/opt/yuce/sourcecode}"
DEPLOY_KEY="$HOME/.ssh/id_ed25519_github_deploy"
SSH_CONFIG="$HOME/.ssh/config"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true

if [[ ! -f "$DEPLOY_KEY" ]]; then
  ssh-keygen -t ed25519 -f "$DEPLOY_KEY" -N "" -C "yuce-server-deploy"
  echo
  echo "=== Add this deploy key to GitHub repo (Settings → Deploy keys → Read-only) ==="
  cat "${DEPLOY_KEY}.pub"
  echo "============================================================================="
  echo "After adding the key on GitHub, run this script again."
  exit 0
fi

if ! grep -q "Host github.com" "$SSH_CONFIG" 2>/dev/null; then
  cat >> "$SSH_CONFIG" <<EOF

Host github.com
  HostName github.com
  User git
  IdentityFile ${DEPLOY_KEY}
  IdentitiesOnly yes
EOF
  chmod 600 "$SSH_CONFIG"
fi

if ssh -T git@github.com 2>&1 | grep -qi "successfully authenticated"; then
  echo "GitHub SSH OK"
else
  echo "GitHub SSH not ready. Add deploy key:"
  cat "${DEPLOY_KEY}.pub"
  exit 1
fi

mkdir -p "$(dirname "$TARGET_DIR")"
if [[ -d "$TARGET_DIR/.git" ]]; then
  cd "$TARGET_DIR"
  git fetch origin
  git checkout main
  git pull --ff-only origin main
  echo "Updated $(pwd) -> $(git rev-parse --short HEAD)"
else
  rm -rf "$TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
  cd "$TARGET_DIR"
  echo "Cloned $(pwd) -> $(git rev-parse --short HEAD)"
fi
