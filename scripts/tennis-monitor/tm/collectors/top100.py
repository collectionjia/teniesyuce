"""ATP/WTA Top100：排名/赛程各查一次；进行中仅轮询比分+赔率。"""
from __future__ import annotations

import copy
import os
import time
from datetime import datetime, timezone
from typing import Any

from tm.bundle import (
    enrich_odds_for_events,
    enrich_rankings_from_events,
    fill_missing_birth_years,
    slim_event,
    _odds_incomplete,
)
from tm.enrich import _event_tour, _is_ended, _player_side
from tm.collectors.events import collect_tennis_events, today_bj
from tm.clients.sofascore import SofascoreClient, _event_score
from tm.collectors.rankings import attach_matches, event_matches_board, fetch_rank_board, is_live, name_keys, refresh_match_ranks
from tm.collectors.tier_collect import attach_match_enrichment

TOP_N = 100

_last_board: dict[str, Any] | None = None
_last_snapshot: dict[str, Any] | None = None
_board_fetched_date: str | None = None
_scheduled_cache: dict[str, Any] = {"date": None, "events": []}


def fetch_top100_board(client: SofascoreClient) -> dict[str, Any]:
    return fetch_rank_board(client, TOP_N)


def _rebuild_board_indexes(board: dict[str, Any]) -> None:
    ids: set[int] = set()
    keys: set[str] = set()
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            pid = p.get("id")
            if pid is not None:
                ids.add(int(pid))
            for key in name_keys(p.get("name")):
                keys.add(key)
    board["player_ids"] = ids
    board["name_keys"] = keys


def _event_matches_board(ev: dict, board: dict[str, Any]) -> bool:
    ids: set[int] = board.get("player_ids") or set()
    keys: set[str] = board.get("name_keys") or set()
    for side in ("home", "away"):
        p = _player_side(ev, side)
        pid = p.get("id")
        if pid is not None and int(pid) in ids:
            return True
        for key in name_keys(p.get("name")):
            if key in keys:
                return True
    return False


def _ensure_board(client: SofascoreClient, match_date: str, *, force_rankings: bool = False) -> dict[str, Any]:
    global _last_board, _board_fetched_date
    if _last_board and _board_fetched_date == match_date and not force_rankings:
        return _last_board
    board = fetch_top100_board(client)
    _last_board = board
    _board_fetched_date = match_date
    return board


def _scheduled_events_once(client: SofascoreClient, match_date: str, *, force: bool = False) -> list[dict]:
    global _scheduled_cache
    from tm.collectors.events import read_collect_horizon_days

    horizon = read_collect_horizon_days()
    cache_key = f"{match_date}:{horizon}"
    if not force and _scheduled_cache.get("date") == cache_key:
        return list(_scheduled_cache.get("events") or [])
    sched_raw = collect_tennis_events(client, match_date, horizon_days=horizon)
    _scheduled_cache = {"date": cache_key, "events": sched_raw}
    print(f"[top100] scheduled cached date={match_date} horizon={horizon}d events={len(sched_raw)}")
    return list(sched_raw)


def _raw_to_slim_map(raw_events: list[dict], board: dict[str, Any]) -> dict[int, dict]:
    by_id: dict[int, dict] = {}
    for ev in raw_events:
        if _is_ended(ev):
            continue
        if not event_matches_board(ev, board):
            continue
        eid = ev.get("id")
        if eid is None:
            continue
        slim = slim_event(ev)
        slim["scoreText"] = _event_score(ev)
        slim["tour"] = _event_tour(ev)
        by_id[int(eid)] = slim
    return by_id


def _slimis_live(ev: dict) -> bool:
    st = str(ev.get("status") or "").lower()
    stype = str(ev.get("statusType") or "").lower()
    if stype in {"inprogress", "live", "interrupted"}:
        return True
    return "live" in st or "set" in st or "progress" in st


def _snapshot_from_events(
    client: SofascoreClient,
    board: dict[str, Any],
    by_id: dict[int, dict],
    *,
    match_date: str,
    started: float,
    error: str | None,
    odds_by_event: dict[str, Any],
    enrich_birth: bool = True,
) -> dict[str, Any]:
    slim_events = sorted(
        by_id.values(),
        key=lambda e: (e.get("startTimestamp") or 0, e.get("id") or 0),
    )
    live_count = sum(1 for ev in by_id.values() if _slimis_live(ev))
    prev_rankings = dict((_last_snapshot or {}).get("rankingsByPlayer") or {})
    rankings = enrich_rankings_from_events(
        slim_events,
        board,
        client,
        prev_rankings=prev_rankings,
    )
    prev_birth = dict((_last_snapshot or {}).get("birthYearByPlayer") or {})
    birth_by_player = dict(prev_birth)
    if enrich_birth and slim_events:
        try:
            birth_by_player = fill_missing_birth_years(
                client,
                slim_events,
                birth_by_player=prev_birth,
            )
            print(f"[top100] birth years filled {len(birth_by_player)} players")
        except Exception as exc:
            print(f"[top100] birth year enrich failed: {exc}")
            birth_by_player = prev_birth
    for ev in slim_events:
        attach_match_enrichment(ev, rankings, odds_by_event)
    attach_matches(board, slim_events)
    refresh_match_ranks(board, rankings)
    elapsed = round(time.time() - started, 2)
    return {
        "ok": True,
        "date": match_date,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "elapsed_sec": elapsed,
        "live_count": live_count,
        "total_events": len(slim_events),
        "error": error,
        "events": slim_events,
        "rankingsByPlayer": rankings,
        "oddsByEvent": odds_by_event,
        "birthYearByPlayer": birth_by_player,
        "top100": {
            "atp": board["atp"],
            "wta": board["wta"],
            "player_ids": board.get("player_ids"),
            "name_keys": board.get("name_keys"),
            "summary": {
                "total_matches": len(slim_events),
                "live_matches": live_count,
                "atp_players": len(board["atp"]),
                "wta_players": len(board["wta"]),
            },
        },
        "filter": "top100",
        "top_rank_max": TOP_N,
        "collect_mode": "full",
    }


def collect_top100_snapshot(*, include_scheduled: bool = True, force_schedule: bool = False) -> dict[str, Any]:
    """全量：Top100 排名（日缓存）+ 赛程（日缓存一次）+ 未开始/进行中各拉一次赔率。"""
    global _last_board, _last_snapshot
    match_date = today_bj()
    started = time.time()
    error: str | None = None

    with SofascoreClient() as client:
        client.warm_up()
        try:
            board = _ensure_board(client, match_date)
        except Exception as exc:
            raise RuntimeError(f"Top100 排名拉取失败: {exc}") from exc

        raw_events: list[dict] = []
        try:
            raw_events.extend(list((client.get_live_tennis_events().get("events") or [])))
        except Exception as exc:
            error = f"live fetch failed: {exc}"
            print(f"[top100] {error}")

        if include_scheduled:
            try:
                raw_events.extend(_scheduled_events_once(client, match_date, force=force_schedule))
            except Exception as exc:
                msg = f"scheduled fetch failed: {exc}"
                print(f"[top100] {msg}")
                error = f"{error}; {msg}" if error else msg

        by_id = _raw_to_slim_map(raw_events, board)
        prev_odds = dict((_last_snapshot or {}).get("oddsByEvent") or {})
        need_odds: list[dict] = []
        for slim in by_id.values():
            eid = slim.get("id")
            if eid is None:
                continue
            key = str(eid)
            if key not in prev_odds or _odds_incomplete(prev_odds.get(key)):
                need_odds.append(slim)

        odds_by_event = dict(prev_odds)
        if need_odds:
            try:
                fresh = enrich_odds_for_events(client, need_odds)
                odds_by_event.update(fresh)
                print(f"[top100] odds fetched once for {len(fresh)} events")
            except Exception as exc:
                print(f"[top100] odds enrich failed: {exc}")

        snap = _snapshot_from_events(
            client,
            board,
            by_id,
            match_date=match_date,
            started=started,
            error=error,
            odds_by_event=odds_by_event,
            enrich_birth=True,
        )
        from tm.collectors.events import get_collect_stats

        client_stats = client.get_request_stats()
        collect_stats = get_collect_stats()
        snap["requests"] = {
            **client_stats,
            "collect": collect_stats,
            "estimated_formula": "warmup + rankings + live + schedule + odds + birth",
        }
        _last_snapshot = snap
        return snap


def refresh_top100_live() -> dict[str, Any]:
    """轻量轮询：仅 live 列表 + 进行中场次赔率/比分（不重拉排名与赛程）。"""
    global _last_snapshot
    match_date = today_bj()
    if not _last_board or not _last_snapshot:
        print("[top100] live refresh: no cache, running full collect once")
        return collect_top100_snapshot(include_scheduled=True)

    started = time.time()
    error: str | None = None
    board = copy.deepcopy(_last_board)
    by_id = {int(e["id"]): dict(e) for e in (_last_snapshot.get("events") or []) if e.get("id") is not None}
    odds_by_event = dict(_last_snapshot.get("oddsByEvent") or {})

    skip_warm = os.environ.get("SOFA_SKIP_WARM_ON_LIVE", "1") == "1"
    client_stats: dict[str, int] = {}
    with SofascoreClient(skip_warm=skip_warm) as client:
        try:
            live_raw = list((client.get_live_tennis_events().get("events") or []))
        except Exception as exc:
            error = f"live fetch failed: {exc}"
            print(f"[top100/live] {error}")
            live_raw = []

        live_top100: list[dict] = []
        for ev in live_raw:
            if _is_ended(ev):
                continue
            if not event_matches_board(ev, board):
                continue
            live_top100.append(ev)
            eid = int(ev["id"])
            slim = slim_event(ev)
            slim["scoreText"] = _event_score(ev)
            slim["tour"] = _event_tour(ev)
            prev = by_id.get(eid) or {}
            slim = {**prev, **slim}
            by_id[eid] = slim

        if live_top100:
            try:
                slim_live = [by_id[int(ev["id"])] for ev in live_top100 if ev.get("id") is not None]
                fresh_odds = enrich_odds_for_events(client, slim_live)
                odds_by_event.update(fresh_odds)
                print(f"[top100/live] odds refreshed for {len(fresh_odds)} live events")
            except Exception as exc:
                print(f"[top100/live] odds failed: {exc}")
        client_stats = client.get_request_stats()

        snap = _snapshot_from_events(
            client,
            board,
            by_id,
            match_date=match_date,
            started=started,
            error=error,
            odds_by_event=odds_by_event,
            # live 轮询沿用已有出生年，避免每次补拉拖慢
            enrich_birth=False,
        )
    snap["collect_mode"] = "live"
    snap["requests"] = client_stats
    _last_snapshot = snap
    restore_top100_board(snap.get("top100"))
    return snap


def restore_top100_board(data: dict[str, Any] | None) -> None:
    global _last_board
    if not data or not (data.get("atp") or data.get("wta")):
        return
    board = dict(data)
    if not board.get("player_ids") or not board.get("name_keys"):
        _rebuild_board_indexes(board)
    _last_board = board


def get_cached_top100_board() -> dict[str, Any] | None:
    return _last_board


def get_cached_top100_snapshot() -> dict[str, Any] | None:
    return _last_snapshot


def build_top100_response() -> dict[str, Any]:
    board = _last_board
    if not board:
        return {"ok": False, "error": "暂无 Top100 数据，请先触发采集", "loading": False}
    return {
        "ok": True,
        "date": today_bj(),
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "loading": False,
        "atp": board.get("atp") or [],
        "wta": board.get("wta") or [],
        "summary": {
            "atp_players": len(board.get("atp") or []),
            "wta_players": len(board.get("wta") or []),
        },
    }
