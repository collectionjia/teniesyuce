"""每分钟采集进行中网球比赛状态与全局比分，写入 MySQL。"""
from __future__ import annotations

import json
import time
import unicodedata
from datetime import datetime, timezone
from typing import Any

from bundle import slim_event
from db_writer import connect, update_live_events
from enrich import _is_ended, _player_side
from events_collector import collect_tennis_events, today_bj
from sofascore_client import SofascoreClient, _event_score


def _is_live(ev: dict) -> bool:
    st = str((ev.get("status") or {}).get("type") or "").lower()
    if st in {"inprogress", "live", "interrupted"}:
        return True
    desc = str((ev.get("status") or {}).get("description") or "").lower()
    return any(k in desc for k in ("live", "progress", "set"))


def _norm_name(s: str | None) -> str:
    return unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower().strip()


def _match_key(home: str | None, away: str | None) -> str:
    return f"{_norm_name(home)}|{_norm_name(away)}"


def _player_names(ev: dict) -> tuple[str | None, str | None]:
    home = _player_side(ev, "home").get("name")
    away = _player_side(ev, "away").get("name")
    return home, away


def collect_live_snapshot(*, include_scheduled: bool = True) -> dict[str, Any]:
    """拉取 Sofascore 进行中 + 当日赛程，合并后返回 slim 事件列表。"""
    match_date = today_bj()
    started = time.time()
    live_raw: list[dict] = []
    sched_raw: list[dict] = []
    error: str | None = None

    with SofascoreClient() as client:
        client.warm_up()
        try:
            live_payload = client.get_live_tennis_events()
            live_raw = list(live_payload.get("events") or [])
        except Exception as exc:
            error = f"live fetch failed: {exc}"
            print(f"[live] {error}")
        if include_scheduled:
            try:
                sched_raw = collect_tennis_events(client, match_date)
            except Exception as exc:
                msg = f"scheduled fetch failed: {exc}"
                print(f"[live] {msg}")
                error = f"{error}; {msg}" if error else msg

    by_id: dict[int, dict] = {}
    for ev in sched_raw:
        eid = ev.get("id")
        if eid is not None:
            by_id[int(eid)] = ev
    for ev in live_raw:
        eid = ev.get("id")
        if eid is not None:
            by_id[int(eid)] = ev

    slim_events: list[dict] = []
    live_count = 0
    ended_count = 0
    for ev in by_id.values():
        slim = slim_event(ev)
        slim["scoreText"] = _event_score(ev)
        if _is_live(ev):
            live_count += 1
        if _is_ended(ev):
            ended_count += 1
        slim_events.append(slim)

    slim_events.sort(key=lambda e: (e.get("startTimestamp") or 0, e.get("id") or 0))
    elapsed = round(time.time() - started, 2)
    return {
        "ok": True,
        "date": match_date,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "elapsed_sec": elapsed,
        "live_count": live_count,
        "ended_count": ended_count,
        "total_events": len(slim_events),
        "error": error,
        "events": slim_events,
    }


def run_live_sync(*, include_scheduled: bool = True) -> dict[str, Any]:
    snapshot = collect_live_snapshot(include_scheduled=include_scheduled)
    conn = connect()
    try:
        db_result = update_live_events(conn, snapshot.get("events") or [])
        snapshot["db"] = db_result
    finally:
        conn.close()
    live_only = [
        e for e in snapshot.get("events") or []
        if not _is_ended({"status": {"description": e.get("status"), "type": e.get("statusType")}})
        and _is_live({"status": {"description": e.get("status"), "type": e.get("statusType")}})
    ]
    snapshot["live_matches"] = live_only
    return snapshot


if __name__ == "__main__":
    import sys

    out = run_live_sync(include_scheduled="--live-only" not in sys.argv)
    payload = {k: v for k, v in out.items() if k not in ("events",)}
    payload["events_sample"] = (out.get("events") or [])[:5]
    print(json.dumps(payload, ensure_ascii=False, indent=2))
