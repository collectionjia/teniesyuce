#!/usr/bin/env python3
"""把本地看板缓存写入服务器本机 Redis（生产 9016）。

用法（在 215 上，或本机 SSH 隧道后）:
  REDIS_URL=redis://127.0.0.1:9016 python tennis-live-board/push_redis_prod.py

本机经 SSH 隧道:
  ssh -N -L 19016:127.0.0.1:9016 -p 53022 root@46.250.163.215
  REDIS_URL=redis://127.0.0.1:19016 python tennis-live-board/push_redis_prod.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MONITOR = ROOT.parent / "scripts" / "tennis-monitor"
sys.path.insert(0, str(MONITOR))
sys.path.insert(0, str(ROOT))

# 默认生产宿主机 Redis；可被环境变量覆盖
os.environ.setdefault("REDIS_URL", "redis://127.0.0.1:9016")

import server as board  # noqa: E402


def main() -> int:
    disk = board._load_disk_board()
    if not disk or not disk.get("ok"):
        print("no board cache · 先打开看板拉一次数据", file=sys.stderr)
        return 1
    with board._cache_lock:
        board._cache["data"] = disk
        board._cache["at"] = time.time()
    print("REDIS_URL=", os.environ.get("REDIS_URL"))
    print("events=", len(disk.get("events") or []), "live=", len(disk.get("live") or []))
    full = board.sync_full_to_redis(force=False)
    print("full:", json.dumps({k: full.get(k) for k in ("ok", "error", "events", "redis_url_host")}, ensure_ascii=False))
    print(" redis:", full.get("redis"))
    live = board.sync_live_to_redis(force=False)
    print("live:", json.dumps({k: live.get(k) for k in ("ok", "error", "events", "redis_url_host")}, ensure_ascii=False))
    print(" redis:", live.get("redis"))
    return 0 if full.get("ok") and live.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
