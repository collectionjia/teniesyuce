#!/usr/bin/env bash
# 服务器常用路径: /opt/yuce/deploy-from-sourcecode.sh → 请与本文件保持同步
exec "$(cd "$(dirname "$0")" && pwd)/server/deploy-from-sourcecode.sh" "$@"
