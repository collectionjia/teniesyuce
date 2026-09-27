from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from tm.enrich import (
    _event_gender,
    _event_tour,
    _player_side,
    _birth_year_from_team,
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
    home_score_obj = ev.get("homeScore") if isinstance(ev.get("homeScore"), dict) else None
    away_score_obj = ev.get("awayScore") if isinstance(ev.get("awayScore"), dict) else None
    # tennis 的 current=盘分；有 period 时不要把 current 写成 home_score（前端 ?? 会把 0 当成比分）
    def _flat_score(obj: dict | None) -> Any:
        if not obj:
            return None
        if any(obj.get(f"period{i}") is not None for i in range(1, 6)):
            return None
        return obj.get("current")

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
        "homeScore": home_score_obj if home_score_obj is not None else ev.get("homeScore"),
        "awayScore": away_score_obj if away_score_obj is not None else ev.get("awayScore"),
        "home_score": _flat_score(home_score_obj),
        "away_score": _flat_score(away_score_obj),
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
            # 禁止用现排名冒充历史最高/上周：榜单接口常无 bestRanking
            out[str(pid)] = {
                "current": rank,
                "previous": p.get("previousRank") if p.get("previousRank") is not None else p.get("previous"),
                "best": p.get("bestRank") if p.get("bestRank") is not None else p.get("best"),
                "live": p.get("liveRank"),
                "utr": p.get("utr"),
            }
    return out


def _merge_event_ranks(rankings: dict[str, dict], ev: dict) -> None:
    for side in (ev.get("homePlayer") or {}, ev.get("awayPlayer") or {}):
        pid = side.get("id")
        rank = side.get("rank")
        if pid is None:
            continue
        key = str(pid)
        prev = rankings.get(key) or {}
        rankings[key] = {
            "current": prev.get("current") if prev.get("current") is not None else rank,
            "previous": prev.get("previous"),
            "best": prev.get("best"),
            "live": prev.get("live"),
            "utr": prev.get("utr"),
        }


def _rank_rows_from_payload(data: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not data or not isinstance(data, dict):
        return []
    for key in ("rankings", "list", "playerRankings"):
        rows = data.get(key)
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict)]
    return []


def parse_player_rank_detail(data: dict[str, Any] | None) -> dict[str, Any]:
    """解析 team/{id}/rankings：取出官方现排 / 上周 / 历史最高。

    历史最高只取官方榜（rankingClass=team / type 5|6）的 bestRanking，
    勿用 livetennis / utr 行的 bestRanking（那不是 WTA/ATP 生涯最高）。
    """
    out: dict[str, Any] = {"current": None, "previous": None, "best": None, "live": None, "utr": None}
    for row in _rank_rows_from_payload(data):
        cls = str(row.get("rankingClass") or "").lower()
        typ = row.get("type")
        ranking = _num(row.get("ranking") if row.get("ranking") is not None else row.get("rank"))
        previous = _num(row.get("previousRanking") if row.get("previousRanking") is not None else row.get("previousRank"))
        best = _num(row.get("bestRanking") if row.get("bestRanking") is not None else row.get("bestRank"))
        if cls == "utr" or typ in (34, 35):
            if ranking is not None:
                out["utr"] = ranking
            continue
        if cls in {"livetennis", "live"} or typ in (7, 8):
            if ranking is not None:
                out["live"] = ranking
            continue
        # 官方 ATP/WTA（team）
        if cls in {"team", ""} or typ in (5, 6) or out["current"] is None:
            if ranking is not None and out["current"] is None:
                out["current"] = int(ranking) if ranking == int(ranking) else ranking
            if previous is not None and out["previous"] is None:
                out["previous"] = int(previous) if previous == int(previous) else previous
            if best is not None and (out["best"] is None or best < out["best"]):
                out["best"] = int(best) if best == int(best) else best
    return out


def fetch_player_rank_detail(client: SofascoreClient, player_id: int) -> dict[str, Any] | None:
    for path in (f"team/{player_id}/rankings", f"player/{player_id}/rankings"):
        try:
            data = client._api_get(path, referer="https://www.sofascore.com/tennis")
            parsed = parse_player_rank_detail(data)
            if any(parsed.get(k) is not None for k in ("best", "current", "previous", "live", "utr")):
                return parsed
        except Exception:
            continue
    return None


def fill_missing_historical_ranks(
    client: SofascoreClient,
    rankings: dict[str, dict[str, Any]],
    events: list[dict] | None = None,
    *,
    max_players: int | None = None,
) -> int:
    """仅对有赛程的球员补拉 team/{id}/rankings 史高；不扫整榜缺 best。"""
    import os

    cap = max_players
    if cap is None:
        cap = int(os.environ.get("SOFA_BEST_RANK_ENRICH_MAX", "80"))
    need: list[int] = []
    seen: set[int] = set()
    for ev in events or []:
        for side in (ev.get("homePlayer") or {}, ev.get("awayPlayer") or {}):
            pid = side.get("id")
            if pid is None:
                continue
            ipid = int(pid)
            if ipid in seen:
                continue
            seen.add(ipid)
            row = rankings.get(str(ipid)) or {}
            if row.get("best") is None:
                need.append(ipid)

    filled = 0
    for pid in need[: max(0, cap)]:
        detail = fetch_player_rank_detail(client, pid)
        if not detail:
            continue
        key = str(pid)
        row = dict(rankings.get(key) or {})
        for field in ("previous", "current", "live", "utr"):
            if row.get(field) is None and detail.get(field) is not None:
                row[field] = detail[field]
        if detail.get("best") is not None:
            if row.get("best") != detail["best"]:
                filled += 1
            row["best"] = detail["best"]
        rankings[key] = row
        time.sleep(0.25)
    return filled


def _merge_prev_rankings(
    rankings: dict[str, dict[str, Any]],
    prev: dict[str, dict[str, Any]] | None,
) -> None:
    """保留上次已补全的 best 等字段，避免全量重采时 ATP 史高被榜单空值冲掉。"""
    if not prev:
        return
    for key, old in prev.items():
        if not isinstance(old, dict):
            continue
        row = dict(rankings.get(key) or {})
        changed = False
        for field in ("best", "previous", "live", "utr", "current"):
            if row.get(field) is None and old.get(field) is not None:
                row[field] = old[field]
                changed = True
        if changed or key not in rankings:
            rankings[key] = row


def enrich_rankings_from_events(
    events: list[dict],
    board: dict[str, Any] | None,
    client: SofascoreClient | None = None,
    prev_rankings: dict[str, dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    rankings = rankings_from_board(board)
    _merge_prev_rankings(rankings, prev_rankings)
    for ev in events or []:
        _merge_event_ranks(rankings, ev)
    if client is not None and rankings:
        filled = fill_missing_historical_ranks(client, rankings, events or [])
        if filled:
            print(f"      历史最高排名补全 {filled} 人（team/.../rankings）")
    return rankings



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


AGE_REF_YEAR = 2026  # 年龄 = 2026 − 出生年


def age_from_birth_year(year: int | None) -> int | None:
    if year is None:
        return None
    try:
        age = AGE_REF_YEAR - int(year)
    except (TypeError, ValueError):
        return None
    return age if 10 <= age <= 80 else None


def fetch_player_birth_year(client: SofascoreClient, player_id: int) -> int | None:
    """年龄为空时去球员详情页拉出生年月日，返回出生年。"""
    for path in (f"team/{player_id}", f"player/{player_id}"):
        try:
            data = client._api_get(path, referer="https://www.sofascore.com/tennis")
            team = data.get("team") or data.get("player") or data
            year = _birth_year_from_team(team if isinstance(team, dict) else {})
            if year is not None:
                return year
        except Exception:
            continue
    return None


def fill_missing_birth_years(
    client: SofascoreClient,
    events: list[dict],
    *,
    birth_by_player: dict[str, int] | None = None,
    max_players: int | None = None,
) -> dict[str, int]:
    """年龄/出生年缺失时补拉 team|player/{id} 出生年月日，年龄=2026−出生年。"""
    import os

    out: dict[str, int] = dict(birth_by_player or {})
    cap = max_players
    if cap is None:
        cap = int(os.environ.get("SOFA_BIRTH_YEAR_ENRICH_MAX", "80"))
    need: list[int] = []
    seen: set[int] = set()

    def _apply_side(side: dict, year: int) -> None:
        side["birthYear"] = year
        age = age_from_birth_year(year)
        if age is not None:
            side["age"] = age

    for ev in events:
        for side in (ev.get("homePlayer") or {}, ev.get("awayPlayer") or {}):
            pid = side.get("id")
            if pid is None:
                continue
            ipid = int(pid)
            if ipid in seen:
                continue
            key = str(ipid)
            # 已有出生年 → 直接算年龄
            by = side.get("birthYear")
            if by is None and out.get(key) is not None:
                by = out[key]
            if by is not None:
                try:
                    year = int(by)
                    out[key] = year
                    _apply_side(side, year)
                    seen.add(ipid)
                    continue
                except (TypeError, ValueError):
                    pass
            # 已有有效年龄则跳过远端拉取
            age_raw = side.get("age")
            if age_raw is not None and age_raw != "":
                try:
                    if 10 <= int(float(age_raw)) <= 80:
                        seen.add(ipid)
                        continue
                except (TypeError, ValueError):
                    pass
            seen.add(ipid)
            need.append(ipid)

    filled = 0
    for pid in need[: max(0, cap)]:
        year = fetch_player_birth_year(client, pid)
        if not year:
            time.sleep(0.2)
            continue
        key = str(pid)
        out[key] = year
        filled += 1
        for ev in events:
            for side in (ev.get("homePlayer") or {}, ev.get("awayPlayer") or {}):
                if side.get("id") == pid:
                    _apply_side(side, year)
        time.sleep(0.25)
    if filled:
        print(f"      出生年月日补全 {filled} 人 → 年龄=2026−出生年（team|player/...）")
    return out


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


def enrich_bundle(
    client: SofascoreClient,
    events: list[dict],
    top20: dict[str, Any] | None,
) -> dict[str, Any]:
    rankings = enrich_rankings_from_events(events, top20, client)
    odds_by_event: dict[str, Any] = {}
    birth_by_player: dict[str, int] = {}

    for ev in events:
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

    birth_by_player = fill_missing_birth_years(client, events)

    return {
        "rankingsByPlayer": rankings,
        "oddsByEvent": odds_by_event,
        "birthYearByPlayer": birth_by_player,
    }
