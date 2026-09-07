#!/usr/bin/env bash
# schedule.json 须由 tennis-monitor 运行用户（ubuntu）可写
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/config"
USER_NAME="${1:-ubuntu}"
sudo chown -R "$USER_NAME:$USER_NAME" "$CFG"
sudo chmod 775 "$CFG"
sudo chmod 664 "$CFG/schedule.json" 2>/dev/null || true
echo "OK: $CFG owned by $USER_NAME"
