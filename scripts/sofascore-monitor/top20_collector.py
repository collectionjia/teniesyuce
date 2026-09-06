"""ATP/WTA Top20 球员比赛采集（轻量，少占代理流量）。"""
from __future__ import annotations

import os
import time
import unicodedata
from datetime import datetime, timezone
from typing import Any

from bundle import slim_event
from bundle_enrich import enrich_bundle
from enrich import _event_tour, _is_ended, _player_side
from events_collector import collect_tennis_events, today_bj
from sofascore_client import SofascoreClient, _event_score

TOP_N = int(os.environ.get("SOFA_TOP_N", "20"))
RANK_PATHS = (("atp", "rankings/type/7"), ("wta", "rankings/type/6"))

_last_board: dict[str, Any] | None = None


def norm_name(s: str | None) -> str:
    return unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower().strip()


def _name_keys(name: str | None) -> set[str]:
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


def fetch_top20_board(client: SofascoreClient) -> dict[str, Any]:
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
        for row in rows[:TOP_N]:
            team = row.get("team") or row.get("player") or {}
            pid = team.get("id") or row.get("id")
            name = team.get("name") or row.get("name")
            if pid is not None:
                board["player_ids"].add(int(pid))
            for key in _name_keys(name):
                board["name_keys"].add(key)
            players.append(
                {
                    "id": pid,
                    "rank": row.get("ranking") or row.get("rank"),
                    "previousRank": row.get("previousRanking") or row.get("previousRank"),
                    "bestRank": row.get("bestRanking") or row.get("bestRank"),
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


def event_matches_top20(ev: dict, board: dict[str, Any]) -> bool:
    ids: set[int] = board.get("player_ids") or set()
    keys: set[str] = board.get("name_keys") or set()
    for side in ("home", "away"):
        p = _player_side(ev, side)
        pid = p.get("id")
        if pid is not None and int(pid) in ids:
            return True
        for key in _name_keys(p.get("name")):
            if key in keys:
                return True
    return False


def _board_player_maps(board: dict[str, Any]) -> tuple[dict[str, dict], dict[int, dict]]:
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


def _lookup_player_rank(
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


def _refresh_match_ranks(board: dict[str, Any], rankings: dict[str, dict] | None = None) -> None:
    by_name, by_id = _board_player_maps(board)
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            for m in p.get("matches") or []:
                home = m.get("home")
                away = m.get("away")
                home_p = m.get("homePlayer") or {}
                away_p = m.get("awayPlayer") or {}
                home_rank = _lookup_player_rank(
                    by_name=by_name,
                    by_id=by_id,
                    rankings=rankings,
                    pid=home_p.get("id"),
                    name=home if isinstance(home, str) else None,
                    event_rank=m.get("homeRank") if m.get("homeRank") is not None else home_p.get("rank"),
                )
                away_rank = _lookup_player_rank(
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
                        m["opponentRank"] = _lookup_player_rank(
                            by_name=by_name,
                            by_id=by_id,
                            rankings=rankings,
                            name=opp_name if isinstance(opp_name, str) else None,
                        )


def _attach_matches(board: dict[str, Any], events: list[dict]) -> None:
    by_name, by_id = _board_player_maps(board)
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            p["matches"] = []

    for ev in events:
        home = ev.get("home")
        away = ev.get("away")
        home_p = ev.get("homePlayer") or {}
        away_p = ev.get("awayPlayer") or {}
        home_rank = _lookup_player_rank(
            by_name=by_name,
            by_id=by_id,
            pid=home_p.get("id"),
            name=home if isinstance(home, str) else None,
            event_rank=home_p.get("rank"),
        )
        away_rank = _lookup_player_rank(
            by_name=by_name,
            by_id=by_id,
            pid=away_p.get("id"),
            name=away if isinstance(away, str) else None,
            event_rank=away_p.get("rank"),
        )
        eid = ev.get("id")
        for name, opp, player_rank, opp_rank in (
            (home, away, home_rank, away_rank),
            (away, home, away_rank, home_rank),
        ):
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


def _is_live(ev: dict) -> bool:
    st = str((ev.get("status") or {}).get("type") or ev.get("statusType") or "").lower()
    if st in {"inprogress", "live", "interrupted"}:
        return True
    desc = str((ev.get("status") or {}).get("description") or ev.get("status") or "").lower()
    return any(k in desc for k in ("live", "progress", "set"))


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
            board = fetch_top20_board(client)
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
            if not event_matches_top20(ev, board):
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
