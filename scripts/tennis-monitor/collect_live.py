#!/usr/bin/env python3
"""进行中采集：IPWO → live Top100/tier → Polymarket → 排名/赔率 → Redis

写入（独立，不合并 collect 全量包）:
  Redis  tennis:bundle:inplay       （collect_live 专用）
  文件   output/daily_live_bundle_*.json
  标识   dataSource=collect_live · collectScript=collect_live

用法:
  python collect_live.py                       # 默认：进行中 · GS/500/1000 · Top100
  python collect_live.py --filter=true --all   # tier，不过滤 Top100
  python collect_live.py --filter=false        # 仅进行中前 N 场（无 tier/Top100）
  python collect_live.py --filter=false --limit=10
"""
from __future__ import annotations

import argparse
import os
import sys

from tm.env import load_monitor_env

load_monitor_env()

from tm.collectors.tier_collect import format_duration
from tm.collectors.tier_live_collect import run_tier_live_collect

_DEFAULT_LIMIT = int(os.environ.get("SOFA_LIVE_SIMPLE_LIMIT", "20"))


def _parse_bool(value: str) -> bool:
    v = value.strip().lower()
    if v in {"1", "true", "yes", "on"}:
        return True
    if v in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"布尔值无效: {value}（可用 true/false）")


def main() -> int:
    parser = argparse.ArgumentParser(description="网球进行中采集（默认 Top100 + 进行中 tier）")
    parser.add_argument(
        "--filter",
        type=_parse_bool,
        default=True,
        metavar="BOOL",
        help="true=进行中·tier·Top100（默认）；false=仅进行中前N场；--all 可跳过 Top100",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=_DEFAULT_LIMIT,
        metavar="N",
        help=f"--filter=false 时采集场数（默认 {_DEFAULT_LIMIT}，可用 SOFA_LIVE_SIMPLE_LIMIT）",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="与 --filter=true 联用：不过滤 Top100",
    )
    args, _unknown = parser.parse_known_args(sys.argv[1:])
    if args.all and not args.filter:
        print("提示: --all 仅在 --filter=true 时生效，已忽略")
    if args.limit < 1:
        print("错误: --limit 须 >= 1")
        return 2
    top100 = not args.all
    result = run_tier_live_collect(
        filter_conditions=args.filter,
        top100=top100,
        simple_limit=args.limit if not args.filter else None,
    )
    timing = result.get("timing") or {}
    redis_info = (result.get("persist") or {}).get("redis") or {}
    if not result.get("total_events"):
        total = timing.get("total")
        if total is not None:
            print(f"完成: 无进行中比赛 · 总耗时 {format_duration(total)}")
        else:
            print("完成: 无进行中比赛")
        return 0
    req = result.get("requests") or {}
    total = timing.get("total")
    total_part = f"总耗时 {format_duration(total)}" if total is not None else ""
    redis_part = ""
    if redis_info.get("ok"):
        redis_part = f"Redis ✓ {redis_info.get('key')} {result.get('total_events')} 场"
    elif redis_info.get("skipped"):
        redis_part = "Redis 跳过"
    elif redis_info.get("error"):
        redis_part = "Redis 失败"
    if result.get("filter_conditions"):
        mode = "tier+Top100"
    else:
        mode = f"前{result.get('simple_limit') or args.limit}场"
    print(
        f"完成: {result.get('total_events')} 场进行中 ({mode}) · "
        f"PM {len(result.get('polymarketByEvent') or {})} · "
        f"{redis_part} · "
        f"HTTP {req.get('http_total')} 次 "
        f"(api={req.get('http_api')} poly={req.get('poly_requests', 0)}req)"
        + (f" · {total_part}" if total_part else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
