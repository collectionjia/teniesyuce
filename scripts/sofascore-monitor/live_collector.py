"""进行中轮询：Top100 轻量刷新（比分+赔率）；Top20 全量仍供定时采集用。"""
from __future__ import annotations

import json
import os
from typing import Any

from enrich import _is_ended
from top100_collector import collect_top100_snapshot, refresh_top100_live
from top20_collector import _is_live, collect_top20_snapshot


def _event_is_live(ev: dict) -> bool:
    return _is_live(
        {
            "status": {"description": ev.get("status"), "type": ev.get("statusType")},
            "statusType": ev.get("statusType"),
        }
    )


def _live_matches_from_snapshot(snapshot: dict[str, Any]) -> list[dict]:
    return [
        e
        for e in snapshot.get("events") or []
        if not _is_ended({"status": {"description": e.get("status"), "type": e.get("statusType")}})
        and _event_is_live(e)
    ]


def run_top100_live_sync() -> dict[str, Any]:
    snapshot = refresh_top100_live()
    snapshot["db"] = {"updated": 0, "ended": 0, "skipped": True}
    snapshot["live_matches"] = _live_matches_from_snapshot(snapshot)
    return snapshot


def run_live_sync(*, include_scheduled: bool = True, write_mysql: bool = False) -> dict[str, Any]:
    use_top100 = os.environ.get("LIVE_USE_TOP100", "1") == "1"
    if use_top100:
        if include_scheduled:
            snapshot = collect_top100_snapshot(include_scheduled=True)
        else:
            snapshot = run_top100_live_sync()
    else:
        snapshot = collect_top20_snapshot(include_scheduled=include_scheduled)
        snapshot["db"] = {"updated": 0, "ended": 0, "skipped": True}
        snapshot["live_matches"] = _live_matches_from_snapshot(snapshot)
        return snapshot

    snapshot["db"] = {"updated": 0, "ended": 0, "skipped": True}
    if "live_matches" not in snapshot:
        snapshot["live_matches"] = _live_matches_from_snapshot(snapshot)
    return snapshot


if __name__ == "__main__":
    import sys

    out = run_live_sync(include_scheduled="--live-only" not in sys.argv)
    payload = {k: v for k, v in out.items() if k not in ("events", "top20", "top100")}
    payload["events_sample"] = (out.get("events") or [])[:5]
    payload["top100_summary"] = (out.get("top100") or {}).get("summary")
    payload["top20_summary"] = (out.get("top20") or {}).get("summary")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
