#!/usr/bin/env python3

"""采集 Sofascore 网球今日 live + upcoming（500/1000/GS；走 monitor.env 里的 IPWO 代理）。"""

from __future__ import annotations



import json

import sys

from datetime import datetime, timezone

from pathlib import Path

from typing import Any



from monitor_env import load_monitor_env



load_monitor_env()



from bundle import slim_event

from enrich import _is_ended

from events_collector import _is_live, collect_tennis_events, get_collect_stats, today_bj

from ipwo_proxy import proxy_status_public

from sofascore_client import SofascoreClient



APP_DIR = Path(__file__).resolve().parent

OUTPUT_DIR = APP_DIR / "output"





def _bucket(ev: dict) -> str:

    if _is_live(ev):

        return "live"

    if _is_ended(ev):

        return "finished"

    return "upcoming"





def collect_today(*, match_date: str | None = None) -> dict[str, Any]:

    d = match_date or today_bj()

    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    with SofascoreClient() as client:

        raw = collect_tennis_events(client, d)



    collect_stats = get_collect_stats()

    slim = [slim_event(ev) for ev in raw]

    buckets: dict[str, list[dict[str, Any]]] = {"live": [], "upcoming": [], "finished": []}

    for ev, s in zip(raw, slim):

        key = _bucket(ev)

        buckets[key].append(s)



    payload = {

        "ok": True,

        "date": d,

        "fetched_at": fetched_at,

        "source": "https://www.sofascore.com/tennis",

        "proxy": proxy_status_public(),

        "collect": collect_stats,

        "tournaments": collect_stats.get("tournaments") or [],

        "summary": {

            "total": len(slim),

            "live": len(buckets["live"]),

            "upcoming": len(buckets["upcoming"]),

            "finished": len(buckets["finished"]),

            "tier_tournaments": collect_stats.get("tier") or 0,

            "listed_tournaments": collect_stats.get("listed") or 0,

        },

        "live": buckets["live"],

        "upcoming": buckets["upcoming"],

        "finished": buckets["finished"],

        "events": slim,

    }

    return payload





def main() -> int:

    match_date = sys.argv[1] if len(sys.argv) > 1 else None

    try:

        payload = collect_today(match_date=match_date)

    except Exception as exc:

        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))

        return 1



    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    d = payload["date"]

    out_path = OUTPUT_DIR / f"today_tennis_{d}.json"

    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({"ok": True, "file": str(out_path), "summary": payload["summary"]}, ensure_ascii=False, indent=2))

    return 0





if __name__ == "__main__":

    raise SystemExit(main())

