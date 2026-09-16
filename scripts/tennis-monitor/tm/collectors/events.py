"""Collect tennis events: list scheduled tournaments, then fetch 500/1000/GS draws only."""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from tm.enrich import _event_tour, _is_ended, tour_level_label

BJ = timezone(timedelta(hours=8))

_last_collect_stats: dict[str, Any] = {}


def today_bj() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d")


def get_collect_stats() -> dict[str, Any]:
    return dict(_last_collect_stats)


def event_local_date(ev: dict, tz: timezone = BJ) -> str | None:
    ts = ev.get("startTimestamp")
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz).strftime("%Y-%m-%d")


def _shift_date(match_date: str, days: int) -> str:
    base = datetime.strptime(match_date, "%Y-%m-%d").date()
    return (base + timedelta(days=days)).strftime("%Y-%m-%d")


def collect_date_list(start_date: str, horizon_days: int = 1) -> list[str]:
    n = max(1, int(horizon_days or 1))
    return [_shift_date(start_date, i) for i in range(n)]


def read_collect_horizon_days() -> int:
    """从 config/schedule.json 读采集跨度（今天起 1/2/3/5 天），默认 1。"""
    allowed = (1, 2, 3, 5)
    try:
        from tm.env import MONITOR_ROOT

        path = MONITOR_ROOT / "config" / "schedule.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            n = int(data.get("collect_horizon_days") or 1)
            if n in allowed:
                return n
    except Exception:
        pass
    return 1


def _is_live(ev: dict) -> bool:
    stype = str((ev.get("status") or {}).get("type") or "").lower()
    desc = str((ev.get("status") or {}).get("description") or "").lower()
    return stype in {"inprogress", "live", "interrupted"} or "live" in desc


def _is_active_on_dates(ev: dict, date_set: set[str]) -> bool:
    if _is_ended(ev):
        return False
    if _is_live(ev):
        return True
    local = event_local_date(ev)
    if local and local in date_set:
        return True
    return False


def _is_active_on_date(ev: dict, match_date: str) -> bool:
    return _is_active_on_dates(ev, {match_date, _shift_date(match_date, 1)})


def _tournament_tour(tournament: dict) -> str:
    unique = tournament.get("uniqueTournament") or {}
    cat = str((unique.get("category") or {}).get("slug") or "").lower()
    if "wta" in cat:
        return "WTA"
    return "ATP"


def is_tier_tournament(tournament: dict) -> bool:
    """500 / 1000 / Grand Slam ATP+WTA main-draw tournaments only."""
    unique = tournament.get("uniqueTournament") or {}
    cat = str((unique.get("category") or {}).get("slug") or "").lower()
    if cat not in {"atp", "wta"}:
        return False
    label = tour_level_label({"uniqueTournament": unique, "tournament": tournament}, _tournament_tour(tournament))
    return label.endswith(" GS") or label.endswith(" 1000") or label.endswith(" 500")


def is_tier_event(ev: dict) -> bool:
    label = tour_level_label(ev, _event_tour(ev))
    return label.endswith(" GS") or label.endswith(" 1000") or label.endswith(" 500")


def slim_tournament(tournament: dict) -> dict[str, Any]:
    unique = tournament.get("uniqueTournament") or {}
    cat = unique.get("category") or {}
    tour = _tournament_tour(tournament)
    return {
        "id": tournament.get("id"),
        "uniqueTournamentId": unique.get("id"),
        "name": unique.get("name") or tournament.get("name"),
        "category": cat.get("slug") if isinstance(cat, dict) else cat,
        "tennisPoints": unique.get("tennisPoints"),
        "level": tour_level_label({"uniqueTournament": unique, "tournament": tournament}, tour),
        "tour": tour,
    }


def list_scheduled_tournaments(client, match_date: str) -> tuple[list[dict], int]:
    """Phase 1: scan Sofascore scheduled-tournament pages (metadata only)."""
    tournaments: list[dict] = []
    seen_ids: set[Any] = set()
    page = 1
    while page <= 10:
        data = client._api_get(
            f"sport/tennis/scheduled-tournaments/{match_date}/page/{page}",
            referer="https://www.sofascore.com/tennis",
        )
        for group in data.get("scheduled") or []:
            tournament = group.get("tournament") or {}
            tid = tournament.get("id")
            if tid is None or tid in seen_ids:
                continue
            seen_ids.add(tid)
            tournaments.append(tournament)
        if not data.get("hasNextPage"):
            return tournaments, page
        page += 1
        time.sleep(0.5)
    return tournaments, page


def fetch_tournament_events(client, tournament: dict) -> list[dict]:
    """Phase 2: pull full draw for one tournament."""
    unique = tournament.get("uniqueTournament") or {}
    uid = unique.get("id")
    tid = tournament.get("id")
    if not uid or not tid:
        return []
    seasons = client._api_get(
        f"unique-tournament/{uid}/seasons",
        referer="https://www.sofascore.com/tennis",
    )
    season_list = seasons.get("seasons") or []
    if not season_list:
        return []
    sid = season_list[0]["id"]
    time.sleep(0.5)
    evdata = client._api_get(
        f"tournament/{tid}/season/{sid}/events",
        referer="https://www.sofascore.com/tennis",
    )
    return list(evdata.get("events") or [])


def collect_tennis_events(
    client,
    match_date: str | None = None,
    *,
    horizon_days: int | None = None,
) -> list[dict]:
    global _last_collect_stats
    d0 = match_date or today_bj()
    horizon = int(horizon_days) if horizon_days is not None else read_collect_horizon_days()
    if horizon not in (1, 2, 3, 5):
        horizon = 1
    dates = collect_date_list(d0, horizon)
    date_set = set(dates)
    events: list[dict] = []
    seen: set[Any] = set()
    sofa_range_ids: set[Any] = set()
    live_tier = 0
    live_skipped = 0

    def add(ev: dict, *, from_sofa_day: str | None = None) -> None:
        eid = ev.get("id")
        if eid is None or eid in seen:
            if eid is not None and from_sofa_day in date_set:
                sofa_range_ids.add(eid)
            return
        seen.add(eid)
        if from_sofa_day in date_set:
            sofa_range_ids.add(eid)
        events.append(ev)

    for ev in client.get_live_tennis_events().get("events") or []:
        if is_tier_event(ev):
            live_tier += 1
            add(ev)
        else:
            live_skipped += 1

    listed_all: list[dict] = []
    listed_seen: set[Any] = set()
    pages_total = 0
    detail_errors = 0
    detail_fetched = 0
    tier_tournaments: list[dict] = []
    tier_seen: set[Any] = set()

    for d in dates:
        listed, pages = list_scheduled_tournaments(client, d)
        pages_total += pages
        for t in listed:
            tid = t.get("id")
            if tid is None or tid in listed_seen:
                continue
            listed_seen.add(tid)
            listed_all.append(t)
        for tournament in listed:
            if not is_tier_tournament(tournament):
                continue
            tid = tournament.get("id")
            if tid is not None and tid in tier_seen:
                continue
            if tid is not None:
                tier_seen.add(tid)
            tier_tournaments.append(tournament)
            name = (tournament.get("uniqueTournament") or {}).get("name") or tournament.get("name") or "?"
            try:
                detail_fetched += 1
                for ev in fetch_tournament_events(client, tournament):
                    if _is_active_on_dates(ev, date_set):
                        add(ev, from_sofa_day=d)
            except Exception as exc:
                detail_errors += 1
                print(f"[events] tier tournament {name} skip: {exc}")

    kept: list[dict] = []
    for ev in events:
        if _is_ended(ev):
            continue
        if _is_live(ev):
            kept.append(ev)
            continue
        bj = event_local_date(ev)
        eid = ev.get("id")
        if (bj and bj in date_set) or eid in sofa_range_ids:
            kept.append(ev)

    wta = sum(1 for ev in kept if _event_tour(ev) == "WTA")
    end_d = dates[-1] if dates else d0
    _last_collect_stats = {
        "date": d0,
        "date_end": end_d,
        "horizon_days": horizon,
        "dates": dates,
        "pages": pages_total,
        "listed": len(listed_all),
        "tier": len(tier_tournaments),
        "tier_detail_fetched": detail_fetched,
        "tier_detail_errors": detail_errors,
        "live_tier": live_tier,
        "live_skipped": live_skipped,
        "raw_events": len(events),
        "kept_events": len(kept),
        "wta_kept": wta,
        "tournaments": [slim_tournament(t) for t in tier_tournaments],
        "requests": {
            "live": 1,
            "scheduled_pages": pages_total,
            "tier_detail": detail_fetched * 2,
            "estimated": 2 + 1 + pages_total + detail_fetched * 2,
        },
    }
    print(
        f"[events] {d0}..{end_d} ({horizon}d): listed={len(listed_all)} pages={pages_total} "
        f"tier={len(tier_tournaments)} kept={len(kept)} live={live_tier} "
        f"live_skip={live_skipped} wta={wta}"
    )
    if os.environ.get("SOFA_LOG_MATCHES", "1") == "1" and kept:
        from tm.collectors.tier_collect import log_tier_matches

        log_tier_matches(kept)
    return kept


def collect_live_tennis_events(client) -> list[dict]:
    """仅拉取进行中 tier 赛事（GS/500/1000），供 collect_live.py 使用。"""
    global _last_collect_stats
    d = today_bj()
    kept: list[dict] = []
    live_tier = 0
    live_skipped = 0
    for ev in client.get_live_tennis_events().get("events") or []:
        if _is_ended(ev):
            continue
        if not _is_live(ev):
            continue
        if is_tier_event(ev):
            live_tier += 1
            kept.append(ev)
        else:
            live_skipped += 1
    wta = sum(1 for ev in kept if _event_tour(ev) == "WTA")
    _last_collect_stats = {
        "date": d,
        "pages": 0,
        "listed": 0,
        "tier": 0,
        "tier_detail_fetched": 0,
        "tier_detail_errors": 0,
        "live_tier": live_tier,
        "live_skipped": live_skipped,
        "raw_events": live_tier + live_skipped,
        "kept_events": len(kept),
        "wta_kept": wta,
        "tournaments": [],
        "requests": {
            "live": 1,
            "scheduled_pages": 0,
            "tier_detail": 0,
            "estimated": 2 + 1,
        },
    }
    print(
        f"[events/live] {d}: live_tier={live_tier} live_skip={live_skipped} "
        f"kept={len(kept)} wta={wta}"
    )
    return kept


def collect_live_events_simple(client, *, limit: int = 20) -> list[dict]:
    """仅拉取进行中赛事，不做 tier/Top100 过滤，取前 limit 场。"""
    global _last_collect_stats
    d = today_bj()
    live_all: list[dict] = []
    for ev in client.get_live_tennis_events().get("events") or []:
        if _is_ended(ev):
            continue
        if not _is_live(ev):
            continue
        live_all.append(ev)
    live_all.sort(key=lambda e: (e.get("startTimestamp") or 0, e.get("id") or 0))
    kept = live_all[:limit]
    wta = sum(1 for ev in kept if _event_tour(ev) == "WTA")
    _last_collect_stats = {
        "date": d,
        "pages": 0,
        "listed": 0,
        "tier": 0,
        "tier_detail_fetched": 0,
        "tier_detail_errors": 0,
        "live_tier": len(live_all),
        "live_skipped": 0,
        "raw_events": len(live_all),
        "kept_events": len(kept),
        "wta_kept": wta,
        "tournaments": [],
        "simple_limit": limit,
        "requests": {
            "live": 1,
            "scheduled_pages": 0,
            "tier_detail": 0,
            "estimated": 2 + 1,
        },
    }
    print(
        f"[events/live/simple] {d}: live={len(live_all)} kept={len(kept)}/{limit} wta={wta}"
    )
    return kept
