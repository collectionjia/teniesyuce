"""
深度翻页拉 OpenDota 数据，填补 2025-10 ~ 2026-06 缺口。

用法：
  python scripts/import_gap.py                    # 默认 50 页 = 5000 场
  python scripts/import_gap.py --pages 80        # 80 页 = 8000 场
  python scripts/import_gap.py --start 2025-10  # 从某月开拉
"""
import sys
import os
import asyncio
import argparse
from datetime import datetime
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match
from dota2elo.opendota import OpenDotaClient


async def import_gap(pages: int = 50, start_date: str = "2025-10-01"):
    """深度翻页拉 OpenDota 数据。"""
    start_ts = int(datetime.strptime(start_date, "%Y-%m-%d").timestamp())
    print(f"开始拉取，最少 {pages} 页，每页 100 场")
    print(f"目标起点: {start_date} (ts={start_ts})")
    print()

    n_pulled = 0
    n_added = 0
    n_skipped = 0
    n_too_old = 0
    t0 = time.time()

    async with OpenDotaClient() as client:
        # 先拉第一页拿到最新 match_id
        first_page = await client.fetch_pro_matches()
        if not first_page:
            print("OpenDota 返回空")
            return
        cur_less = first_page[0]["match_id"] + 1

        for page_i in range(pages):
            if page_i == 0:
                matches = first_page
            else:
                matches = await client.fetch_pro_matches(less_than_match_id=cur_less)

            if not matches:
                print(f"  page {page_i+1}: 空，停止")
                break

            cur_less = matches[-1]["match_id"] - 1
            oldest_ts = min(m.get("start_time", 0) for m in matches)
            oldest_date = datetime.fromtimestamp(oldest_ts).strftime("%Y-%m-%d")

            # 过滤到 start_date 之后
            new_matches = [m for m in matches if m.get("start_time", 0) >= start_ts]
            too_old = len(matches) - len(new_matches)

            # 写入 DB
            added = 0
            if new_matches:
                added = _save_matches(new_matches)
                n_added += added

            n_pulled += len(matches)
            n_too_old += too_old

            elapsed = time.time() - t0
            rate = (page_i + 1) / elapsed if elapsed > 0 else 0
            print(f"  page {page_i+1}/{pages} 拉 {len(matches)} 场 (新 {len(new_matches)}, 加 {added})  "
                  f"oldest={oldest_date}  ({elapsed:.0f}s, {rate:.2f}/s)")

            if too_old > 0 and len(new_matches) == 0:
                print(f"  整页都太老，停止")
                break

    elapsed = time.time() - t0
    print()
    print(f"完成: 拉 {n_pulled}, 加 {n_added}, 太老 {n_too_old}, 耗时 {elapsed:.0f}s")


def _save_matches(matches: list) -> int:
    """把比赛列表写入 DB。返回新加的数量。"""
    from dota2elo.ingest import upsert_pro_match_list

    with session_scope() as s:
        before = s.query(Match).count()
        upsert_pro_match_list(s, matches)
        s.commit()
        after = s.query(Match).count()
        return after - before


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", type=int, default=50)
    parser.add_argument("--start", default="2025-10-01")
    args = parser.parse_args()

    asyncio.run(import_gap(pages=args.pages, start_date=args.start))


if __name__ == "__main__":
    main()