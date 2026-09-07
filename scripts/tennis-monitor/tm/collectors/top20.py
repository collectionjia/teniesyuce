"""ATP/WTA Top20 collector."""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any

from tm.bundle import enrich_bundle, slim_event
from tm.enrich import _event_tour, _is_ended
from tm.collectors.events import collect_tennis_events, today_bj
from tm.collectors.rankings import (
    attach_matches,
    event_matches_board,
    fetch_rank_board,
    is_live,
    refresh_match_ranks,
)
from tm.clients.sofascore import SofascoreClient, _event_score

TOP_N = int(os.environ.get("SOFA_TOP_N", "20"))
_last_board: dict[str, Any] | None = None

def collect_top20_snapshot(*, include_scheduled: bool = True) -> dict[str, Any]:
    global _last_board
    match_date = today_bj()
    started = time.time()
    error: str | None = None
    board: dict[str, Any] | None = None
    raw_events: list[dict] = []
    enrich_extra: dict[str, Any] = {}

    with SofascoreClient() as client:
        client.warm_up()
        try:
            board = fetch_rank_board(client, TOP_N)
            _last_board = board
        except Exception as exc:
            raise RuntimeError(f"Top20 排名拉取失败: {exc}") from exc

        try:
            live_raw = list((client.get_live_tennis_events().get("events") or []))
            raw_events.extend(live_raw)
        except Exception as exc:
            error = f"live fetch failed: {exc}"
            print(f"[top20] {error}")

        if include_scheduled:
            try:
                sched_raw = collect_tennis_events(client, match_date)
                raw_events.extend(sched_raw)
            except Exception as exc:
                msg = f"scheduled fetch failed: {exc}"
                print(f"[top20] {msg}")
                error = f"{error}; {msg}" if error else msg

        assert board is not None
        by_id: dict[int, dict] = {}
        for ev in raw_events:
            if _is_ended(ev):
                continue
            if not event_matches_board(ev, board):
                continue
            eid = ev.get("id")
            if eid is not None:
                by_id[int(eid)] = ev

        slim_events: list[dict] = []
        live_count = 0
        ended_count = 0
        for ev in by_id.values():
            slim = slim_event(ev)
            slim["scoreText"] = _event_score(ev)
            slim["tour"] = _event_tour(ev)
            if _is_live(ev):
                live_count += 1
            if _is_ended(ev):
                ended_count += 1
            slim_events.append(slim)

        slim_events.sort(key=lambda e: (e.get("startTimestamp") or 0, e.get("id") or 0))
        _attach_matches(board, slim_events)

        try:
            enrich_extra = enrich_bundle(
                client,
                slim_events,
                {"atp": board["atp"], "wta": board["wta"]},
            )
            print(
                f"[top20] enrich ranks={len(enrich_extra.get('rankingsByPlayer') or {})} "
                f"odds={len(enrich_extra.get('oddsByEvent') or {})}"
            )
        except Exception as exc:
            print(f"[top20] enrich failed: {exc}")
            enrich_extra = {}

        _refresh_match_ranks(board, enrich_extra.get("rankingsByPlayer") or {})

    assert board is not None
    atp_n = sum(1 for e in slim_events if e.get("tour") == "ATP")
    wta_n = sum(1 for e in slim_events if e.get("tour") == "WTA")
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
        "rankingsByPlayer": enrich_extra.get("rankingsByPlayer") or {},
        "oddsByEvent": enrich_extra.get("oddsByEvent") or {},
        "birthYearByPlayer": enrich_extra.get("birthYearByPlayer") or {},
        "top20": {
            "atp": board["atp"],
            "wta": board["wta"],
            "summary": {
                "total_matches": len(slim_events),
                "atp_matches": atp_n,
                "wta_matches": wta_n,
                "atp_players": len(board["atp"]),
                "wta_players": len(board["wta"]),
            },
        },
        "filter": "top20",
        "top_rank_max": TOP_N,
    }


def restore_top20_board(data: dict[str, Any] | None) -> None:
    global _last_board
    if data and (data.get("atp") or data.get("wta")):
        _last_board = data


def get_cached_top20_payload() -> dict[str, Any] | None:
    return _last_board


def build_top20_response(events: list[dict] | None = None) -> dict[str, Any]:
    board = _last_board
    if board and events:
        _attach_matches(board, events)
    if not board:
        return {"ok": False, "error": "暂无 Top20 数据，请先触发采集", "loading": False}
    if events:
        total = len(events)
        atp_m = sum(1 for e in events if e.get("tour") == "ATP")
        wta_m = sum(1 for e in events if e.get("tour") == "WTA")
    else:
        ids: set[Any] = set()
        for p in (board.get("atp") or []) + (board.get("wta") or []):
            for m in p.get("matches") or []:
                if m.get("id") is not None:
                    ids.add(m["id"])
        total = len(ids)
        atp_m = wta_m = 0
    summary = {"total_matches": total, "atp_matches": atp_m, "wta_matches": wta_m}
    return {
        "ok": True,
        "date": today_bj(),
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "loading": False,
        "atp": board.get("atp") or [],
        "wta": board.get("wta") or [],
        "summary": summary,
    }
