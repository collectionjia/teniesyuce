"""Shared ATP/WTA ranking board helpers."""
from __future__ import annotations

import unicodedata
from typing import Any

from tm.enrich import _player_side
from tm.clients.sofascore import SofascoreClient

RANK_PATHS = (("atp", "rankings/type/7"), ("wta", "rankings/type/6"))


def norm_name(s: str | None) -> str:
    return unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower().strip()


def name_keys(name: str | None) -> set[str]:
    base = norm_name(name)
    if not base:
        return set()
    keys = {base}
    parts = base.split()
    if parts:
        keys.add(parts[-1])
    if len(parts) >= 2:
        keys.add(f"{parts[-1]} {parts[0][:1]}")
    return keys


def fetch_rank_board(client: SofascoreClient, top_n: int) -> dict[str, Any]:
    board: dict[str, Any] = {
        "atp": [],
        "wta": [],
        "name_keys": set(),
        "player_ids": set(),
    }
    for tour, path in RANK_PATHS:
        data = client._api_get(path, referer="https://www.sofascore.com/tennis")
        rows = data.get("rankings") or data.get("list") or []
        players: list[dict[str, Any]] = []
        for row in rows[:top_n]:
            team = row.get("team") or row.get("player") or {}
            pid = team.get("id") or row.get("id")
            name = team.get("name") or row.get("name")
            if pid is not None:
                board["player_ids"].add(int(pid))
            for key in name_keys(name):
                board["name_keys"].add(key)
            players.append(
                {
                    "id": pid,
                    "rank": row.get("ranking") or row.get("rank"),
                    "previousRank": row.get("previousRanking") or row.get("previousRank"),
                    # 榜单列表常无 best；勿用现排名冒充，留给 team/.../rankings 补全
                    "bestRank": row.get("bestRanking") or row.get("bestRank") or (team.get("bestRanking") if isinstance(team, dict) else None),
                    "name": name,
                    "country": (team.get("country") or {}).get("name")
                    if isinstance(team.get("country"), dict)
                    else team.get("country"),
                    "points": row.get("points") or row.get("rowPoints"),
                    "matches": [],
                    "matchCount": 0,
                }
            )
        board[tour] = players
    return board


def event_matches_board(ev: dict, board: dict[str, Any]) -> bool:
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


def board_player_maps(board: dict[str, Any]) -> tuple[dict[str, dict], dict[int, dict]]:
    by_name: dict[str, dict] = {}
    by_id: dict[int, dict] = {}
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            if p.get("name"):
                by_name[norm_name(p["name"])] = p
            pid = p.get("id")
            if pid is not None:
                by_id[int(pid)] = p
    return by_name, by_id


def lookup_player_rank(
    *,
    by_name: dict[str, dict],
    by_id: dict[int, dict],
    rankings: dict[str, dict] | None = None,
    pid: Any = None,
    name: str | None = None,
    event_rank: Any = None,
) -> Any:
    if pid is not None and rankings:
        row = rankings.get(str(pid)) or {}
        if row.get("current") is not None:
            return row.get("current")
    if pid is not None:
        p = by_id.get(int(pid))
        if p and p.get("rank") is not None:
            return p.get("rank")
    if name:
        p = by_name.get(norm_name(name))
        if p and p.get("rank") is not None:
            return p.get("rank")
    return event_rank


def refresh_match_ranks(board: dict[str, Any], rankings: dict[str, dict] | None = None) -> None:
    by_name, by_id = board_player_maps(board)
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            for m in p.get("matches") or []:
                home = m.get("home")
                away = m.get("away")
                home_p = m.get("homePlayer") or {}
                away_p = m.get("awayPlayer") or {}
                home_rank = lookup_player_rank(
                    by_name=by_name,
                    by_id=by_id,
                    rankings=rankings,
                    pid=home_p.get("id"),
                    name=home if isinstance(home, str) else None,
                    event_rank=m.get("homeRank") if m.get("homeRank") is not None else home_p.get("rank"),
                )
                away_rank = lookup_player_rank(
                    by_name=by_name,
                    by_id=by_id,
                    rankings=rankings,
                    pid=away_p.get("id"),
                    name=away if isinstance(away, str) else None,
                    event_rank=m.get("awayRank") if m.get("awayRank") is not None else away_p.get("rank"),
                )
                m["homeRank"] = home_rank
                m["awayRank"] = away_rank
                if norm_name(p.get("name")) == norm_name(home):
                    m["playerRank"] = home_rank if home_rank is not None else p.get("rank")
                    m["opponentRank"] = away_rank
                elif norm_name(p.get("name")) == norm_name(away):
                    m["playerRank"] = away_rank if away_rank is not None else p.get("rank")
                    m["opponentRank"] = home_rank
                else:
                    m["playerRank"] = p.get("rank")
                    if m.get("opponentRank") is None:
                        opp_name = m.get("opponent")
                        m["opponentRank"] = lookup_player_rank(
                            by_name=by_name,
                            by_id=by_id,
                            rankings=rankings,
                            name=opp_name if isinstance(opp_name, str) else None,
                        )


def attach_matches(board: dict[str, Any], events: list[dict]) -> None:
    by_name, by_id = board_player_maps(board)
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            p["matches"] = []

    for ev in events:
        home = ev.get("home")
        away = ev.get("away")
        home_p = ev.get("homePlayer") or {}
        away_p = ev.get("awayPlayer") or {}
        home_rank = lookup_player_rank(
            by_name=by_name,
            by_id=by_id,
            pid=home_p.get("id"),
            name=home if isinstance(home, str) else None,
            event_rank=home_p.get("rank"),
        )
        away_rank = lookup_player_rank(
            by_name=by_name,
            by_id=by_id,
            pid=away_p.get("id"),
            name=away if isinstance(away, str) else None,
            event_rank=away_p.get("rank"),
        )
        eid = ev.get("id")
        for name, opp, player_rank, opp_rank, side_p in (
            (home, away, home_rank, away_rank, home_p),
            (away, home, away_rank, home_rank, away_p),
        ):
            player = None
            pid = side_p.get("id") if isinstance(side_p, dict) else None
            if pid is not None:
                player = by_id.get(int(pid))
            if not player and isinstance(name, str):
                player = by_name.get(norm_name(name))
            if not player:
                continue
            matches = player.setdefault("matches", [])
            if eid is not None and any(m.get("id") == eid for m in matches):
                continue
            matches.append(
                {
                    "id": eid,
                    "home": home,
                    "away": away,
                    "homePlayer": home_p,
                    "awayPlayer": away_p,
                    "opponent": opp,
                    "playerRank": player.get("rank") if player.get("rank") is not None else player_rank,
                    "opponentRank": opp_rank,
                    "homeRank": home_rank,
                    "awayRank": away_rank,
                    "status": ev.get("status"),
                    "statusRaw": ev.get("statusType"),
                    "startTime": ev.get("startTime"),
                    "slug": ev.get("slug"),
                    "customId": ev.get("customId"),
                    "url": ev.get("url"),
                    "tournament": ev.get("tournament"),
                    "tournamentShort": ev.get("tournamentShort"),
                    "level": ev.get("level"),
                    "tour": ev.get("tour"),
                    "round": ev.get("roundLabel"),
                }
            )
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            p["matchCount"] = len(p.get("matches") or [])


def is_live(ev: dict) -> bool:
    st = str((ev.get("status") or {}).get("type") or ev.get("statusType") or "").lower()
    if st in {"inprogress", "live", "interrupted"}:
        return True
    desc = str((ev.get("status") or {}).get("description") or ev.get("status") or "").lower()
    return any(k in desc for k in ("live", "progress", "set"))


