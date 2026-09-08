#!/usr/bin/env python3
"""简化采集：IPWO → Top100/tier → Polymarket → Sofascore → 输出 → Redis

写入（独立，不写入 collect_live）:
  Redis  tennis:bundle:full          （collect 全量赛程）
  文件   output/daily_bundle_*.json
  标识   dataSource=collect · collectScript=collect

用法:
  python collect.py              # 今天，Top100 过滤（默认）
  python collect.py 2026-09-07   # 指定日期
  python collect.py --all        # 不过滤 Top100（全部 tier 场次）
"""
from __future__ import annotations

import sys

from tm.env import load_monitor_env

load_monitor_env()

from tm.collectors.tier_collect import format_duration, run_tier_collect


def main() -> int:
    args = [a for a in sys.argv[1:] if a and not a.startswith("-")]
    top100 = "--all" not in sys.argv
    match_date = args[0] if args else None
    result = run_tier_collect(match_date=match_date, top100=top100)
    timing = result.get("timing") or {}
    redis_info = (result.get("persist") or {}).get("redis") or {}
    if not result.get("total_events"):
        total = timing.get("total")
        if total is not None:
            print(f"完成: 无比赛 · 总耗时 {format_duration(total)}")
        return 1
    req = result.get("requests") or {}
    total = timing.get("total")
    total_part = f"总耗时 {format_duration(total)}" if total is not None else ""
    redis_part = ""
    if redis_info.get("ok"):
        redis_part = f"Redis ✓ {redis_info.get('events')} 场"
    elif redis_info.get("skipped"):
        redis_part = f"Redis 跳过"
    elif redis_info.get("error"):
        redis_part = f"Redis 失败"
    print(
        f"完成: {result.get('total_events')} 场 · "
        f"PM {len(result.get('polymarketByEvent') or {})} · "
        f"{redis_part} · "
        f"HTTP {req.get('http_total')} 次 "
        f"(api={req.get('http_api')} poly={req.get('poly_requests', 0)}req)"
        + (f" · {total_part}" if total_part else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
