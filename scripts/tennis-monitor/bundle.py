from __future__ import annotations

from datetime import datetime, timedelta, timezone

from enrich import (
    _event_gender,
    _event_tour,
    _player_side,
    ground_label,
    round_label,
    tour_level_label,
)
from sofascore_client import _event_score

BJ = timezone(timedelta(hours=8))


def event_match_url(ev: dict) -> str | None:
    """Sofascore 比赛页需 slug + customId，仅 id 会 404。"""
    slug = str(ev.get("slug") or "").strip().strip("/")
    custom_id = str(ev.get("customId") or "").strip().strip("/")
    eid = ev.get("id")
    if slug and custom_id:
        url = f"https://www.sofascore.com/tennis/match/{slug}/{custom_id}"
        if eid is not None:
            url = f"{url}#id:{eid}"
        return url
    if eid is not None:
        return f"https://www.sofascore.com/event/tennis/{eid}"
    return None


def slim_event(ev: dict) -> dict:
    home = _player_side(ev, "home")
    away = _player_side(ev, "away")
    status = ev.get("status") if isinstance(ev.get("status"), dict) else {}
    tournament = ev.get("tournament") or {}
    unique = ev.get("uniqueTournament") or tournament.get("uniqueTournament") or {}
    tour = _event_tour(ev)
    gender = _event_gender(ev)
    if gender:
        home["gender"] = home.get("gender") or gender
        away["gender"] = away.get("gender") or gender
    ts = ev.get("startTimestamp")
    start_time = None
    if ts:
        start_time = datetime.fromtimestamp(int(ts), BJ).strftime("%H:%M")
    eid = ev.get("id")
    ground_type = ev.get("groundType") or unique.get("groundType")
    return {
        "id": eid,
        "level": tour_level_label(ev, tour),
        "tour": tour,
        "gender": gender,
        "tennisPoints": unique.get("tennisPoints"),
        "home": home.get("name"),
        "away": away.get("name"),
        "homePlayer": home,
        "awayPlayer": away,
        "status": status.get("description") or ev.get("status"),
        "statusType": status.get("type") or ev.get("statusType"),
        "homeScore": ev.get("homeScore"),
        "awayScore": ev.get("awayScore"),
        "home_score": (ev.get("homeScore") or {}).get("current")
        if isinstance(ev.get("homeScore"), dict)
        else ev.get("homeScore"),
        "away_score": (ev.get("awayScore") or {}).get("current")
        if isinstance(ev.get("awayScore"), dict)
        else ev.get("awayScore"),
        "scoreText": _event_score(ev),
        "tournament": unique.get("name") or tournament.get("name"),
        "tournamentShort": tournament.get("name") or unique.get("name"),
        "roundInfo": ev.get("roundInfo"),
        "roundLabel": round_label(ev.get("roundInfo")),
        "groundType": ground_type,
        "groundLabel": ground_label(ground_type),
        "startTimestamp": ts,
        "startTime": start_time,
        "slug": ev.get("slug"),
        "customId": ev.get("customId"),
        "url": event_match_url(ev),
    }
