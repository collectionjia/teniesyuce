#!/usr/bin/env bash
# 在能同时访问「源库」和 8.216 生产库 的机器上执行（推荐 215 本机）。
# 默认：215:9100 -> 8.216.45.102:3334/tennisv2
#   bash scripts/sync-mysql-to-prod.sh
# 或指定源：
#   SRC_HOST=127.0.0.1 SRC_PORT=9016 SRC_PASSWORD=123456x bash scripts/sync-mysql-to-prod.sh
set -euo pipefail

SRC_HOST="${SRC_HOST:-127.0.0.1}"
SRC_PORT="${SRC_PORT:-9100}"
SRC_USER="${SRC_USER:-root}"
SRC_PASSWORD="${SRC_PASSWORD:-new-api}"
SRC_DB="${SRC_DB:-tennisv2}"

DST_HOST="${DST_HOST:-8.216.45.102}"
DST_PORT="${DST_PORT:-3334}"
DST_USER="${DST_USER:-root}"
DST_PASSWORD="${DST_PASSWORD:-xytl2024**}"
DST_DB="${DST_DB:-tennisv2}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server"

echo "==> compare row counts (source vs prod)"
node - <<NODE
const mysql = require('mysql2/promise');
const src = { host: '$SRC_HOST', port: $SRC_PORT, user: '$SRC_USER', password: '$SRC_PASSWORD', database: '$SRC_DB' };
const dst = { host: '$DST_HOST', port: $DST_PORT, user: '$DST_USER', password: '$DST_PASSWORD', database: '$DST_DB' };
(async () => {
  for (const [label, cfg] of Object.entries({ src, dst })) {
    const c = await mysql.createConnection({ ...cfg, connectTimeout: 20000 });
    const [u] = await c.query('SELECT COUNT(*) n, MAX(id) max_id FROM users');
    const [s] = await c.query('SELECT COUNT(*) n, MAX(id) max_id FROM scheduler_runs');
    console.log(label, 'users', u[0], 'scheduler_runs', s[0]);
    await c.end();
  }
})();
NODE

echo "==> full sync via node"
export SRC_HOST SRC_PORT SRC_USER SRC_PASSWORD SRC_DB
export DST_HOST DST_PORT DST_USER DST_PASSWORD DST_DB
node scripts/sync-mysql-full.js

echo "==> done"
