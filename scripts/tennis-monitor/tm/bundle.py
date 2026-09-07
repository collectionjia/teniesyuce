from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from tm.enrich import (
    _event_gender,
    _event_tour,
    _player_side,
    ground_label,
    round_label,
    tour_level_label,
)
from tm.clients.sofascore import SofascoreClient, _event_score

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


_MAX_ODDS = int(__import__("os").environ.get("SOFA_MAX_ODDS_FETCH", "30"))


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        n = float(v)
        return n if n == n else None
    except (TypeError, ValueError):
        return None


def rankings_from_board(top20: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not top20:
        return out
    for tour in ("atp", "wta"):
        for p in top20.get(tour) or []:
            pid = p.get("id")
            if pid is None:
                continue
            rank = p.get("rank")
            out[str(pid)] = {
                "current": rank,
                "previous": p.get("previousRank") or p.get("previous") or rank,
                "best": p.get("bestRank") or p.get("best") or rank,
                "live": p.get("liveRank") or rank,
                "utr": p.get("utr"),
            }
    return out


def _merge_event_ranks(rankings: dict[str, dict], ev: dict) -> None:
    for side in (ev.get("homePlayer") or {}, ev.get("awayPlayer") or {}):
        pid = side.get("id")
        rank = side.get("rank")
        if pid is None or rank is None:
            continue
        key = str(pid)
        prev = rankings.get(key) or {}
        rankings[key] = {
            "current": prev.get("current") or rank,
            "previous": prev.get("previous") or rank,
            "best": prev.get("best") or rank,
            "live": prev.get("live") or rank,
            "utr": prev.get("utr"),
        }


def _parse_fractional(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        val = float(raw)
        return val if val > 0 else None
    s = str(raw).strip()
    if "/" in s:
        parts = s.split("/", 1)
        try:
            num, den = float(parts[0]), float(parts[1])
            if den > 0:
                return round(1.0 + num / den, 3)
        except (TypeError, ValueError):
            return None
    return _num(s)


def _pick_decimal(choice: dict) -> float | None:
    if not isinstance(choice, dict):
        return None
    for key in ("decimalValue", "decimal", "initialDecimalValue", "fractionalValue", "initialFractionalValue"):
        val = _parse_fractional(choice.get(key))
        if val is not None:
            return val
    expected = choice.get("expected")
    if expected is not None:
        exp = _num(expected)
        if exp and exp > 0:
            return round(100.0 / exp, 3)
    return None


def _choices_to_home_away(choices: list[dict]) -> tuple[float | None, float | None]:
    home_dec: float | None = None
    away_dec: float | None = None
    for ch in choices or []:
        if not isinstance(ch, dict):
            continue
        dec = _pick_decimal(ch)
        if dec is None:
            continue
        name = str(ch.get("name") or ch.get("choice") or "").strip().lower()
        typ = str(ch.get("type") or ch.get("team") or "").strip().lower()
        if typ in ("home", "1") or name in ("1", "home"):
            home_dec = dec
        elif typ in ("away", "2") or name in ("2", "away"):
            away_dec = dec
    if home_dec is not None or away_dec is not None:
        return home_dec, away_dec
    if len(choices) >= 2:
        return _pick_decimal(choices[0]), _pick_decimal(choices[1])
    return None, None


def _odds_payload(event_id: int, home_dec: float | None, away_dec: float | None) -> dict[str, Any]:
    return {
        "eventId": event_id,
        "source": "sofascore",
        "full_time": {
            "home": {"decimal": home_dec, "change": 0},
            "away": {"decimal": away_dec, "change": 0},
            "source": "sofascore",
        },
    }


def _fetch_winning_odds_pair(client: SofascoreClient, event_id: int) -> tuple[float | None, float | None]:
    win = client._api_get(
        f"event/{event_id}/provider/1/winning-odds",
        referer="https://www.sofascore.com/tennis",
    )
    home_dec = _pick_decimal(win.get("home") or {})
    away_dec = _pick_decimal(win.get("away") or {})
    if home_dec is None and away_dec is None:
        home_dec = _pick_decimal(win.get("homeTeam") or {})
        away_dec = _pick_decimal(win.get("awayTeam") or {})
    return home_dec, away_dec


def _moneyline_market(markets: list[dict]) -> dict | None:
    for mkt in markets or []:
        name = str(mkt.get("marketName") or mkt.get("name") or "").lower()
        if "full time" in name and "home/away" in name:
            return mkt
    for mkt in markets or []:
        name = str(mkt.get("marketName") or mkt.get("name") or "").lower()
        if name in ("full time", "full-time", "winner", "home/away", "match winner"):
            return mkt
    for mkt in markets or []:
        choices = mkt.get("choices") or []
        if len(choices) >= 2 and all(str(c.get("name", "")).isdigit() or c.get("name") in ("1", "2") for c in choices[:2]):
            return mkt
    return (markets or [None])[0]


def _fetch_all_odds_pair(client: SofascoreClient, event_id: int) -> tuple[float | None, float | None]:
    data = client._api_get(
        f"event/{event_id}/odds/1/all",
        referer="https://www.sofascore.com/tennis",
    )
    mkt = _moneyline_market(data.get("markets") or [])
    if not mkt:
        return None, None
    return _choices_to_home_away(mkt.get("choices") or [])


def fetch_event_odds(client: SofascoreClient, event_id: int) -> dict[str, Any] | None:
    home_dec: float | None = None
    away_dec: float | None = None

    try:
        h, a = _fetch_winning_odds_pair(client, event_id)
        home_dec, away_dec = h, a
    except Exception:
        pass

    # winning-odds 常只返回一侧（大热门/封盘）；用 all 盘口补全缺失侧
    if home_dec is None or away_dec is None:
        try:
            h2, a2 = _fetch_all_odds_pair(client, event_id)
            if home_dec is None:
                home_dec = h2
            if away_dec is None:
                away_dec = a2
        except Exception:
            pass

    if home_dec is None and away_dec is None:
        return None
    return _odds_payload(event_id, home_dec, away_dec)


def fetch_player_birth_year(client: SofascoreClient, player_id: int) -> int | None:
    for path in (f"team/{player_id}", f"player/{player_id}"):
        try:
            data = client._api_get(path, referer="https://www.sofascore.com/tennis")
            team = data.get("team") or data.get("player") or data
            ts = team.get("dateOfBirthTimestamp") or team.get("birthDateTimestamp")
            if ts:
                from datetime import datetime, timezone

                return datetime.fromtimestamp(int(ts), timezone.utc).year
        except Exception:
            continue
    return None


def _odds_incomplete(odds: dict[str, Any] | None) -> bool:
    if not odds:
        return True
    ft = odds.get("full_time") or {}
    home = (ft.get("home") or {}).get("decimal")
    away = (ft.get("away") or {}).get("decimal")
    return home is None or away is None


def enrich_odds_for_events(client: SofascoreClient, events: list[dict]) -> dict[str, Any]:
    """仅拉取赔率（进行中轮询用，不走球员资料接口）。"""
    odds_by_event: dict[str, Any] = {}
    for ev in events:
        eid = ev.get("id")
        if eid is None:
            continue
        odds = fetch_event_odds(client, int(eid))
        if odds:
            odds_by_event[str(eid)] = odds
        time.sleep(0.35)
    return odds_by_event


def enrich_rankings_from_events(
    events: list[dict],
    board: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    rankings = rankings_from_board(board)
    for ev in events:
        _merge_event_ranks(rankings, ev)
    return rankings


def enrich_bundle(
    client: SofascoreClient,
    events: list[dict],
    top20: dict[str, Any] | None,
) -> dict[str, Any]:
    rankings = rankings_from_board(top20)
    odds_by_event: dict[str, Any] = {}
    birth_by_player: dict[str, int] = {}

    for ev in events:
        _merge_event_ranks(rankings, ev)
        eid = ev.get("id")
        if eid is None:
            continue
        if len(odds_by_event) < _MAX_ODDS:
            odds = fetch_event_odds(client, int(eid))
            if odds:
                odds_by_event[str(eid)] = odds
            time.sleep(0.35)

    player_ids: set[int] = set()
    for ev in events:
        for side in (ev.get("homePlayer") or {}, ev.get("awayPlayer") or {}):
            pid = side.get("id")
            if pid is not None:
                player_ids.add(int(pid))

    for pid in list(player_ids)[:40]:
        if str(pid) in birth_by_player:
            continue
        year = fetch_player_birth_year(client, pid)
        if year:
            birth_by_player[str(pid)] = year
            for ev in events:
                for side in (ev.get("homePlayer") or {}, ev.get("awayPlayer") or {}):
                    if side.get("id") == pid:
                        side["birthYear"] = year
        time.sleep(0.25)

    return {
        "rankingsByPlayer": rankings,
        "oddsByEvent": odds_by_event,
        "birthYearByPlayer": birth_by_player,
    }
