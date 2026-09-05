#!/usr/bin/env python3
"""Fix tennis schedule date window: fetch adjacent Sofascore days; keep BJ-today + spillover."""
from __future__ import annotations

from pathlib import Path

PATH = Path("/home/ubuntu/sofascore-tennis-scraper/events_collector.py")

NEW = r'''"""Collect tennis events (ATP flat schedule + WTA tournament draws)."""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from enrich import _event_tour, _is_ended

BJ = timezone(timedelta(hours=8))


def today_bj() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d")


def event_local_date(ev: dict, tz: timezone = BJ) -> str | None:
    ts = ev.get("startTimestamp")
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz).strftime("%Y-%m-%d")


def _shift_date(match_date: str, days: int) -> str:
    base = datetime.strptime(match_date, "%Y-%m-%d").date()
    return (base + timedelta(days=days)).strftime("%Y-%m-%d")


def _is_live(ev: dict) -> bool:
    stype = str((ev.get("status") or {}).get("type") or "").lower()
    desc = str((ev.get("status") or {}).get("description") or "").lower()
    return stype in {"inprogress", "live", "interrupted"} or "live" in desc


def _is_active_on_date(ev: dict, match_date: str) -> bool:
    """Keep live matches, BJ-calendar day, and US-evening spillover to next BJ day."""
    if _is_ended(ev):
        return False
    if _is_live(ev):
        return True
    local = event_local_date(ev)
    if local == match_date:
        return True
    # US Open night session: Sofascore day still "today", BJ already next calendar day
    if local == _shift_date(match_date, 1):
        return True
    return False


def _fetch_wta_tournament_events(client, tournament: dict) -> list[dict]:
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


def collect_tennis_events(client, match_date: str | None = None) -> list[dict]:
    """Merge live + category schedule (ATP) + WTA tournament draws for the date.

    Sofascore scheduled-events/{date} follows tournament local calendar (e.g. US Open ET),
    while our product day is Beijing. Fetch adjacent days and keep BJ-today + spillover.
    """
    d = match_date or today_bj()
    days = [_shift_date(d, -1), d, _shift_date(d, 1)]
    events: list[dict] = []
    seen: set[Any] = set()
    sofa_today_ids: set[Any] = set()

    def add(ev: dict, *, from_sofa_day: str | None = None) -> None:
        eid = ev.get("id")
        if eid is None or eid in seen:
            if eid is not None and from_sofa_day == d:
                sofa_today_ids.add(eid)
            return
        seen.add(eid)
        if from_sofa_day == d:
            sofa_today_ids.add(eid)
        events.append(ev)

    for ev in (client.get_live_tennis_events().get("events") or []):
        add(ev)

    for day in days:
        try:
            payload = client.get_scheduled_tennis_events(day)
        except Exception as exc:
            print(f"[events] scheduled {day} skip: {exc}")
            continue
        for ev in payload.get("events") or []:
            add(ev, from_sofa_day=day)
        time.sleep(0.35)

    page = 1
    while page <= 10:
        data = client._api_get(
            f"sport/tennis/scheduled-tournaments/{d}/page/{page}",
            referer="https://www.sofascore.com/tennis",
        )
        for group in data.get("scheduled") or []:
            tournament = group.get("tournament") or {}
            unique = tournament.get("uniqueTournament") or {}
            cat = str((unique.get("category") or {}).get("slug") or "").lower()
            if cat != "wta":
                continue
            try:
                for ev in _fetch_wta_tournament_events(client, tournament):
                    if _is_active_on_date(ev, d):
                        add(ev, from_sofa_day=d)
            except Exception as exc:
                name = tournament.get("name") or unique.get("name") or "?"
                print(f"[events] WTA tournament {name} skip: {exc}")
        if not data.get("hasNextPage"):
            break
        page += 1
        time.sleep(0.5)

    kept: list[dict] = []
    for ev in events:
        if _is_ended(ev):
            continue
        if _is_live(ev):
            kept.append(ev)
            continue
        bj = event_local_date(ev)
        eid = ev.get("id")
        # BJ today, or listed on Sofascore's today slate (covers ET evening → next BJ morning)
        if bj == d or eid in sofa_today_ids:
            kept.append(ev)

    wta = sum(1 for ev in kept if _event_tour(ev) == "WTA")
    print(f"[events] {d}: total={len(kept)} wta={wta} (fetched_days={days})")
    return kept
'''

PATH.write_text(NEW, encoding="utf-8")
print("patched", PATH)
