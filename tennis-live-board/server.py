#!/usr/bin/env python3
"""本地看板：静态页 + /api/board；/api/sync/full|/api/sync/live 推线上 Redis。"""
from __future__ import annotations

import copy
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
MONITOR = ROOT.parent / "scripts" / "tennis-monitor"
if str(MONITOR) not in sys.path:
    sys.path.insert(0, str(MONITOR))


def _load_board_env() -> None:
    """加载 monitor.env（REDIS_URL / IPWO 等），已有环境变量不覆盖。"""
    for name in ("monitor.env", "monitor.env.prod"):
        path = MONITOR / name
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip().strip("\r")
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key, val = key.strip(), val.strip()
            if key and key not in os.environ:
                os.environ[key] = val
        break
    # 看板推送可单独指定 Redis，避免写错测试库
    board_redis = (os.environ.get("SOFA_BOARD_REDIS_URL") or "").strip()
    if board_redis:
        os.environ["REDIS_URL"] = board_redis


_load_board_env()

# 线上 HTTP 推送（生产 Redis 仅服务器本机可达时用）
PUSH_URL = (os.environ.get("SOFA_BOARD_PUSH_URL") or "").rstrip("/")
PUSH_TOKEN = (
    os.environ.get("SOFA_BOARD_PUSH_TOKEN")
    or os.environ.get("SOFA_MONITOR_TOKEN")
    or ""
).strip()
# 本地刷新成功后自动推线上；默认：配置了 PUSH_URL 则开启
_AUTO_PUSH_RAW = (os.environ.get("SOFA_BOARD_AUTO_PUSH") or "").strip().lower()
AUTO_PUSH = (
    _AUTO_PUSH_RAW in {"1", "true", "yes", "on"}
    if _AUTO_PUSH_RAW
    else bool(PUSH_URL)
)
_auto_push_lock = threading.Lock()
_auto_push_inflight: set[str] = set()

from tm.bundle import parse_player_rank_detail, slim_event  # noqa: E402
from tm.bundle_store import (  # noqa: E402
    build_bundle_payload,
    build_live_bundle_payload,
    persist_collect_bundle,
    persist_live_collect,
)
from tm.clients.sofascore import _event_score  # noqa: E402
from tm.clients.sofascore_mobile import SofascoreMobileClient  # noqa: E402
from tm.collectors.events import (  # noqa: E402
    collect_date_list,
    fetch_tournament_events,
    list_scheduled_tournaments,
    read_collect_horizon_days,
    today_bj,
)
from tm.collectors.rankings import (  # noqa: E402
    RANK_PATHS,
    attach_matches,
    board_player_maps,
    event_matches_board,
    lookup_player_rank,
    name_keys,
    norm_name,
)
from tm.enrich import _event_tour, _is_ended, tour_level_label  # noqa: E402

HOST = os.environ.get("SOFA_BOARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("SOFA_BOARD_PORT", "8765"))
# 仅显式配置 SOFA_BOARD_SYNC_TOKEN 时校验；不沿用 SOFA_MONITOR_TOKEN（本地看板按钮否则会 unauthorized）
SYNC_TOKEN = (os.environ.get("SOFA_BOARD_SYNC_TOKEN") or "").strip()
TOP_N = 100
CACHE_DIR = ROOT / ".cache"
BOARD_FILE = CACHE_DIR / "board.json"
RANKS_FILE = CACHE_DIR / "ranks.json"
CACHE_SEC = 90
LIVE_CACHE_SEC = 15
# 排名 + 历史最高：全量补一次，默认缓存 6 小时
RANK_CACHE_SEC = int(os.environ.get("SOFA_RANK_CACHE_SEC", str(6 * 3600)))

_cache: dict[str, Any] = {"at": 0.0, "data": None}
_live_cache: dict[str, Any] = {"at": 0.0}
_cache_lock = threading.Lock()
_build_lock = threading.Lock()
_live_lock = threading.Lock()
_refreshing = False


def _json_safe(obj: Any) -> Any:
    if isinstance(obj, set):
        return sorted(obj)
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    return obj


def _load_disk_board() -> dict[str, Any] | None:
    try:
        if BOARD_FILE.exists():
            data = json.loads(BOARD_FILE.read_text(encoding="utf-8"))
            if data.get("ok"):
                return data
    except Exception as exc:
        print(f"[board] disk load failed: {exc}")
    return None


def _save_disk_board(data: dict[str, Any]) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        BOARD_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        print(f"[board] disk save failed: {exc}")


def _load_rank_cache() -> dict[str, Any] | None:
    try:
        if not RANKS_FILE.exists():
            return None
        data = json.loads(RANKS_FILE.read_text(encoding="utf-8"))
        at = float(data.get("at") or 0)
        if at <= 0 or time.time() - at > RANK_CACHE_SEC:
            return None
        if not (data.get("atp") and data.get("wta")):
            return None
        return data
    except Exception as exc:
        print(f"[board] ranks cache load failed: {exc}")
        return None


def _save_rank_cache(board: dict[str, Any]) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "at": time.time(),
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "atp": board.get("atp") or [],
            "wta": board.get("wta") or [],
        }
        RANKS_FILE.write_text(json.dumps(_json_safe(payload), ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        print(f"[board] ranks cache save failed: {exc}")


def _board_from_rank_cache(cached: dict[str, Any]) -> dict[str, Any]:
    board: dict[str, Any] = {
        "atp": cached.get("atp") or [],
        "wta": cached.get("wta") or [],
        "name_keys": set(),
        "name_exact": set(),
        "player_ids": set(),
    }
    for tour in ("atp", "wta"):
        for p in board[tour]:
            pid = p.get("id")
            if pid is not None:
                board["player_ids"].add(int(pid))
            n = norm_name(p.get("name"))
            if n:
                board["name_exact"].add(n)
            for key in name_keys(p.get("name")):
                board["name_keys"].add(key)
    return board


def _ensure_rank_board(client: SofascoreMobileClient, *, force: bool = False) -> tuple[dict[str, Any], bool]:
    """排名+历史最高只全量补一次（磁盘缓存）；force 时强制重拉。"""
    if not force:
        cached = _load_rank_cache()
        if cached:
            print(f"[board] ranks cache hit · age={int(time.time() - float(cached.get('at') or 0))}s")
            return _board_from_rank_cache(cached), False

    print("[board] ranks full refresh (rankings + bestRank)…")
    board = fetch_rank_board_client(client, TOP_N)
    # 无赛事列表时也补榜上缺的 best（全量一次）
    _fill_best_ranks(client, board, events=[])
    _save_rank_cache(board)
    return board, True


def _group_tournaments(events: list[dict], tour: str) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for ev in events:
        if str(ev.get("tour") or "").lower() != tour:
            continue
        key = ev.get("tournament") or ev.get("tournamentShort") or "Other"
        groups.setdefault(str(key), []).append(ev)
    out = []
    for name, items in sorted(groups.items(), key=lambda x: x[0].lower()):
        items.sort(key=lambda e: (e.get("startTimestamp") or 0, e.get("id") or 0))
        out.append({"name": name, "events": items, "eventCount": len(items)})
    return out


def _is_live(ev: dict) -> bool:
    st = str(ev.get("statusType") or "").lower()
    if st in {"inprogress", "live", "interrupted"}:
        return True
    desc = str(ev.get("status") or "").lower()
    return any(k in desc for k in ("set", "live", "progress"))


def _is_unfinished(ev: dict) -> bool:
    """未开赛 + 比赛中（排除完赛/取消）。"""
    return not _is_ended(ev)


def fetch_rank_board_client(client: SofascoreMobileClient, top_n: int) -> dict[str, Any]:
    board: dict[str, Any] = {
        "atp": [],
        "wta": [],
        "name_keys": set(),
        "name_exact": set(),
        "player_ids": set(),
    }
    for tour, path in RANK_PATHS:
        data = client._api_get(path)
        rows = data.get("rankings") or data.get("list") or []
        players: list[dict[str, Any]] = []
        for row in rows[:top_n]:
            team = row.get("team") or row.get("player") or {}
            pid = team.get("id") or row.get("id")
            name = team.get("name") or row.get("name")
            if pid is not None:
                board["player_ids"].add(int(pid))
            n = norm_name(name)
            if n:
                board["name_exact"].add(n)
            for key in name_keys(name):
                board["name_keys"].add(key)
            players.append(
                {
                    "id": pid,
                    "rank": row.get("ranking") or row.get("rank"),
                    "previousRank": row.get("previousRanking") or row.get("previousRank"),
                    "bestRank": row.get("bestRanking") or row.get("bestRank") or team.get("bestRanking"),
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


def _want_board_tournament(tournament: dict) -> bool:
    """仅 ATP/WTA 500 / 1000。"""
    unique = tournament.get("uniqueTournament") or {}
    cat = str((unique.get("category") or {}).get("slug") or "").lower()
    if cat not in {"atp", "wta"}:
        return False
    tour = "WTA" if cat == "wta" else "ATP"
    label = tour_level_label({"uniqueTournament": unique, "tournament": tournament}, tour)
    return label.endswith(" 1000") or label.endswith(" 500")


def _is_500_1000_event(ev: dict) -> bool:
    label = tour_level_label(ev, _event_tour(ev))
    return label.endswith(" 1000") or label.endswith(" 500")


def _fetch_day_events(client: SofascoreMobileClient, match_date: str) -> list[dict]:
    """赛程（含未开赛）：scheduled-tournaments → tournament/.../events（scheduled-events 已 404）。"""
    horizon = read_collect_horizon_days()
    out: list[dict] = []
    seen: set[int] = set()
    tour_seen: set[Any] = set()
    for d in collect_date_list(match_date, horizon):
        try:
            listed, _pages = list_scheduled_tournaments(client, d)
        except Exception as exc:
            print(f"[board] schedule list {d} failed: {exc}")
            continue
        for tournament in listed:
            tid = tournament.get("id")
            if tid is None or tid in tour_seen:
                continue
            if not _want_board_tournament(tournament):
                continue
            tour_seen.add(tid)
            try:
                evs = fetch_tournament_events(client, tournament)
            except Exception as exc:
                name = (tournament.get("uniqueTournament") or {}).get("name") or tournament.get("name")
                print(f"[board] tournament events skip {name}: {exc}")
                continue
            for ev in evs:
                eid = ev.get("id")
                if eid is None:
                    continue
                iid = int(eid)
                if iid in seen:
                    continue
                seen.add(iid)
                out.append(ev)
    print(f"[board] schedule 500/1000 tournaments={len(tour_seen)} events={len(out)} horizon={horizon}d")
    return out


def _filter_board_from_data(data: dict[str, Any]) -> dict[str, Any]:
    board: dict[str, Any] = {
        "atp": data.get("atp") or [],
        "wta": data.get("wta") or [],
        "player_ids": set(),
        "name_exact": set(),
        "name_keys": set(),
    }
    for tour in ("atp", "wta"):
        for p in board[tour]:
            pid = p.get("id")
            if pid is not None:
                board["player_ids"].add(int(pid))
            n = norm_name(p.get("name"))
            if n:
                board["name_exact"].add(n)
            for key in name_keys(p.get("name")):
                board["name_keys"].add(key)
    return board


def _enrich_event_ranks(ev: dict[str, Any], board: dict[str, Any]) -> None:
    by_name, by_id = board_player_maps(board)
    home_p = ev.get("homePlayer") or {}
    away_p = ev.get("awayPlayer") or {}
    ev["homeRank"] = lookup_player_rank(
        by_name=by_name, by_id=by_id, pid=home_p.get("id"), name=ev.get("home"), event_rank=home_p.get("rank")
    )
    ev["awayRank"] = lookup_player_rank(
        by_name=by_name, by_id=by_id, pid=away_p.get("id"), name=ev.get("away"), event_rank=away_p.get("rank")
    )
    _stamp_player_ranks(ev)


def _stamp_player_ranks(ev: dict[str, Any]) -> None:
    """把现排名/最高写入 homePlayer/awayPlayer，供线上 listRankOf / listBestOf 使用。"""
    home_p = ev.get("homePlayer")
    away_p = ev.get("awayPlayer")
    if isinstance(home_p, dict):
        if ev.get("homeRank") is not None:
            home_p["rank"] = ev["homeRank"]
            home_p["ranking"] = ev["homeRank"]
            home_p["currentRank"] = ev["homeRank"]
        if ev.get("homeBestRank") is not None:
            home_p["bestRank"] = ev["homeBestRank"]
            home_p["best"] = ev["homeBestRank"]
        ev["homePlayer"] = home_p
    if isinstance(away_p, dict):
        if ev.get("awayRank") is not None:
            away_p["rank"] = ev["awayRank"]
            away_p["ranking"] = ev["awayRank"]
            away_p["currentRank"] = ev["awayRank"]
        if ev.get("awayBestRank") is not None:
            away_p["bestRank"] = ev["awayBestRank"]
            away_p["best"] = ev["awayBestRank"]
        ev["awayPlayer"] = away_p


def _fill_best_ranks(client: SofascoreMobileClient, board: dict[str, Any], events: list[dict] | None = None) -> None:
    """全量补 bestRank：只填榜上缺的球员（同一 client + 限速）。events 仅用于回写 homeBestRank。"""
    events = events or []
    by_id: dict[int, dict] = {}
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            pid = p.get("id")
            if pid is not None:
                by_id[int(pid)] = p

    pids: list[int] = []
    seen: set[int] = set()
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            if p.get("bestRank") is not None:
                continue
            pid = p.get("id")
            if pid is None:
                continue
            ipid = int(pid)
            if ipid in seen:
                continue
            seen.add(ipid)
            pids.append(ipid)

    board_cap = max(0, int(os.environ.get("SOFA_BEST_RANK_BOARD_MAX", "200")))
    pids = pids[:board_cap]

    for pid in pids:
        try:
            detail = parse_player_rank_detail(client._api_get(f"team/{pid}/rankings"))
            best = detail.get("best")
            if best is None:
                continue
            if pid in by_id:
                by_id[pid]["bestRank"] = best
        except Exception:
            continue

    _apply_best_from_board(board, events)


def _apply_best_from_board(board: dict[str, Any], events: list[dict]) -> None:
    """用已缓存的榜单 bestRank 写到赛事，不再请求 API。"""
    by_id: dict[int, Any] = {}
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            pid = p.get("id")
            if pid is not None and p.get("bestRank") is not None:
                by_id[int(pid)] = p.get("bestRank")
    for ev in events:
        home_p = ev.get("homePlayer") or {}
        away_p = ev.get("awayPlayer") or {}
        hid, aid = home_p.get("id"), away_p.get("id")
        ev["homeBestRank"] = by_id.get(int(hid)) if hid is not None else None
        ev["awayBestRank"] = by_id.get(int(aid)) if aid is not None else None
        _stamp_player_ranks(ev)


def _rankings_by_player(board: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """线上 TennisBoard 用 rankingsByPlayer[id].current / .best 显示排名。"""
    out: dict[str, dict[str, Any]] = {}
    for tour in ("atp", "wta"):
        for p in board.get(tour) or []:
            pid = p.get("id")
            if pid is None:
                continue
            out[str(int(pid))] = {
                "current": p.get("rank"),
                "previous": p.get("previousRank"),
                "best": p.get("bestRank"),
            }
    return out


def refresh_live_board(*, force: bool = False) -> dict[str, Any]:
    """仅刷新进行中比分（Top100 过滤），15s 缓存。"""
    with _cache_lock:
        base = _cache.get("data")
    if not base:
        return {"ok": False, "error": "榜单未就绪，请先加载完整数据"}

    if not force and time.time() - float(_live_cache.get("at") or 0) < LIVE_CACHE_SEC:
        return {
            "ok": True,
            "skipped": True,
            "live_count": len(base.get("live") or []),
            "summary": base.get("summary") or {},
        }

    with _live_lock:
        if not force and time.time() - float(_live_cache.get("at") or 0) < LIVE_CACHE_SEC:
            return {"ok": True, "skipped": True, "live_count": len(base.get("live") or [])}

        filter_board = _filter_board_from_data(base)
        rank_board = {**filter_board, "atp": filter_board["atp"], "wta": filter_board["wta"]}
        try:
            with SofascoreMobileClient() as client:
                live_raw = list(client.get_live_tennis_events().get("events") or [])
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

        live_slim: list[dict[str, Any]] = []
        for ev in live_raw:
            if not _is_unfinished(ev) or not _is_500_1000_event(ev):
                continue
            slim = slim_event(ev)
            slim["scoreText"] = _event_score(ev)
            slim["tour"] = _event_tour(ev)
            _enrich_event_ranks(slim, rank_board)
            live_slim.append(slim)

        by_id: dict[int, dict[str, Any]] = {
            int(e["id"]): e
            for e in (base.get("events") or [])
            if e.get("id") is not None
            and not _is_live(e)
            and _is_unfinished(e)
            and _is_500_1000_event(e)
        }
        for ev in live_slim:
            by_id[int(ev["id"])] = ev
        events = sorted(
            by_id.values(),
            key=lambda e: (0 if _is_live(e) else 1, e.get("startTimestamp") or 0, e.get("id") or 0),
        )
        live_events = [e for e in events if _is_live(e)]
        upcoming = len(events) - len(live_events)

        updated = copy.deepcopy(base)
        updated["events"] = events
        updated["live"] = live_events
        updated["tournaments"] = {
            "atp": _group_tournaments(events, "atp"),
            "wta": _group_tournaments(events, "wta"),
        }
        updated["summary"] = {
            **(updated.get("summary") or {}),
            "live_events": len(live_events),
            "upcoming_events": upcoming,
            "total_events": len(events),
        }
        updated["live_refreshed_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        with _cache_lock:
            _cache["data"] = updated
        _live_cache["at"] = time.time()
        _save_disk_board(updated)
        _schedule_auto_push("live")

        return _json_safe(
            {
                "ok": True,
                "live_count": len(live_events),
                "live_refreshed_at": updated["live_refreshed_at"],
                "summary": updated["summary"],
                "events": events,
                "live": live_events,
                "tournaments": updated["tournaments"],
            }
        )


def build_board(*, force_ranks: bool = False) -> dict[str, Any]:
    started = time.time()
    match_date = today_bj()
    error: str | None = None
    raw_by_id: dict[int, dict] = {}
    ranks_refreshed = False

    with SofascoreMobileClient() as client:
        try:
            board, ranks_refreshed = _ensure_rank_board(client, force=force_ranks)
        except Exception as exc:
            error = f"ranks: {exc}"
            board = {"atp": [], "wta": [], "player_ids": set(), "name_exact": set(), "name_keys": set()}
        # 先赛程后 live，live 覆盖同场状态
        try:
            for ev in _fetch_day_events(client, match_date):
                eid = ev.get("id")
                if eid is not None:
                    raw_by_id[int(eid)] = ev
        except Exception as exc:
            msg = f"schedule: {exc}"
            error = f"{error}; {msg}" if error else msg
        try:
            for ev in client.get_live_tennis_events().get("events") or []:
                eid = ev.get("id")
                if eid is not None:
                    raw_by_id[int(eid)] = ev
        except Exception as exc:
            msg = f"live: {exc}"
            error = f"{error}; {msg}" if error else msg

        filtered = [
            ev
            for ev in raw_by_id.values()
            if _is_unfinished(ev) and _is_500_1000_event(ev)
        ]
        slim_events: list[dict] = []
        for ev in filtered:
            slim = slim_event(ev)
            slim["scoreText"] = _event_score(ev)
            slim["tour"] = _event_tour(ev)
            slim_events.append(slim)
        slim_events.sort(key=lambda e: (0 if _is_live(e) else 1, e.get("startTimestamp") or 0))

        attach_matches(board, slim_events)
        by_name, by_id = board_player_maps(board)
        for ev in slim_events:
            home_p = ev.get("homePlayer") or {}
            away_p = ev.get("awayPlayer") or {}
            ev["homeRank"] = lookup_player_rank(
                by_name=by_name, by_id=by_id, pid=home_p.get("id"), name=ev.get("home"), event_rank=home_p.get("rank")
            )
            ev["awayRank"] = lookup_player_rank(
                by_name=by_name, by_id=by_id, pid=away_p.get("id"), name=ev.get("away"), event_rank=away_p.get("rank")
            )
        # 历史最高只用缓存榜，不再每次请求
        _apply_best_from_board(board, slim_events)

    live_events = [e for e in slim_events if _is_live(e)]
    upcoming = len(slim_events) - len(live_events)

    return _json_safe(
        {
            "ok": True,
            "date": match_date,
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "elapsed_sec": round(time.time() - started, 2),
            "filter": "atp_wta_500_1000_unfinished",
            "top_rank_max": TOP_N,
            "filter_note": "ATP/WTA 500·1000；仅未开赛+进行中",
            "ranks_refreshed": ranks_refreshed,
            "rank_cache_sec": RANK_CACHE_SEC,
            "error": error,
            "summary": {
                "atp_players": len(board.get("atp") or []),
                "wta_players": len(board.get("wta") or []),
                "total_events": len(slim_events),
                "live_events": len(live_events),
                "upcoming_events": upcoming,
            },
            "atp": board.get("atp") or [],
            "wta": board.get("wta") or [],
            "events": slim_events,
            "live": live_events,
            "tournaments": {
                "atp": _group_tournaments(slim_events, "atp"),
                "wta": _group_tournaments(slim_events, "wta"),
            },
        }
    )


def _store_board(data: dict[str, Any]) -> None:
    with _cache_lock:
        _cache["at"] = time.time()
        _cache["data"] = data
    _live_cache["at"] = 0.0
    _save_disk_board(data)


def _schedule_auto_push(mode: str) -> None:
    """本地数据更新后异步推线上，不阻塞刷新。"""
    if not AUTO_PUSH or not PUSH_URL:
        return
    mode = "full" if mode == "full" else "live"
    with _auto_push_lock:
        if mode in _auto_push_inflight:
            return
        _auto_push_inflight.add(mode)

    def run() -> None:
        try:
            if mode == "full":
                result = sync_full_to_redis(force=False)
            else:
                result = sync_live_to_redis(force=False)
            ok = result.get("ok")
            err = result.get("error")
            n = result.get("events")
            print(f"[board] auto-push {mode}: ok={ok} events={n}" + (f" err={err}" if err else ""))
        except Exception as exc:
            print(f"[board] auto-push {mode} failed: {exc}")
        finally:
            with _auto_push_lock:
                _auto_push_inflight.discard(mode)

    threading.Thread(target=run, daemon=True, name=f"board-auto-push-{mode}").start()


def refresh_board_async(*, force: bool = False, force_ranks: bool = False) -> None:
    global _refreshing
    if not force:
        with _cache_lock:
            age = time.time() - float(_cache.get("at") or 0)
            if _refreshing or (_cache.get("data") and age < CACHE_SEC):
                return
    with _build_lock:
        if _refreshing and not force:
            return
        _refreshing = True
    try:
        print("[board] refreshing…")
        data = build_board(force_ranks=force_ranks)
        _store_board(data)
        print(
            f"[board] ok · {data.get('summary')} · {data.get('elapsed_sec')}s"
            f" · ranks_refreshed={data.get('ranks_refreshed')}"
        )
        _schedule_auto_push("full")
    except Exception as exc:
        print(f"[board] refresh failed: {exc}")
    finally:
        _refreshing = False


def get_board(*, force: bool = False, force_ranks: bool = False) -> dict[str, Any]:
    with _cache_lock:
        cached = _cache.get("data")
        age = time.time() - float(_cache.get("at") or 0)
        if cached and not force and not force_ranks and age < CACHE_SEC:
            return {**cached, "cached": True}

    disk = _load_disk_board()
    if disk and not force and not force_ranks:
        with _cache_lock:
            if not _cache.get("data"):
                _cache["data"] = disk
                _cache["at"] = time.time() - CACHE_SEC - 1
        threading.Thread(target=refresh_board_async, daemon=True).start()
        return {**disk, "cached": True, "stale": True}

    with _build_lock:
        with _cache_lock:
            cached = _cache.get("data")
            age = time.time() - float(_cache.get("at") or 0)
            if cached and not force and not force_ranks and age < CACHE_SEC:
                return {**cached, "cached": True}
        data = build_board(force_ranks=force_ranks)
        _store_board(data)
        _schedule_auto_push("full")
        return data


def warm_startup() -> None:
    disk = _load_disk_board()
    if disk:
        with _cache_lock:
            _cache["data"] = disk
            _cache["at"] = time.time() - CACHE_SEC - 1
        print(f"[board] loaded disk cache · events={len(disk.get('events') or [])}")
    threading.Thread(target=refresh_board_async, daemon=True).start()


def _board_to_collect(board: dict[str, Any]) -> dict[str, Any]:
    events = [_normalize_match_scores(dict(e)) for e in (board.get("events") or []) if isinstance(e, dict)]
    for ev in events:
        _stamp_player_ranks(ev)
    return {
        "date": board.get("date") or today_bj(),
        "events": events,
        "top100": False,
        "rankingsBoard": {
            "atp": board.get("atp") or [],
            "wta": board.get("wta") or [],
            "summary": board.get("summary") or {},
        },
        "rankingsByPlayer": _rankings_by_player(board),
        "top_rank_max": TOP_N,
        "filter_conditions": {"tier": "500_1000", "unfinished": True},
    }


def _normalize_match_scores(ev: dict[str, Any]) -> dict[str, Any]:
    """推 Redis 前：有 period 盘局时清掉误导性的 home_score=盘数 current。"""
    hs = ev.get("homeScore")
    as_ = ev.get("awayScore")
    if isinstance(hs, dict) and any(hs.get(f"period{i}") is not None for i in range(1, 6)):
        ev["home_score"] = None
    if isinstance(as_, dict) and any(as_.get(f"period{i}") is not None for i in range(1, 6)):
        ev["away_score"] = None
    if not ev.get("scoreText") and isinstance(hs, dict) and isinstance(as_, dict):
        parts = []
        for key in ("period1", "period2", "period3", "period4", "period5"):
            if hs.get(key) is not None and as_.get(key) is not None:
                parts.append(f"{hs[key]}-{as_[key]}")
        if parts:
            ev["scoreText"] = " ".join(parts)
    return ev


def _redis_host_public() -> str:
    url = (os.environ.get("REDIS_URL") or "").strip()
    if not url:
        return ""
    # redis://host:port/... → host:port
    try:
        from urllib.parse import urlparse as _up

        u = _up(url)
        return f"{u.hostname}:{u.port}" if u.hostname else url.split("@")[-1][:80]
    except Exception:
        return url[:80]


def _push_http(mode: str, bundle: dict[str, Any]) -> dict[str, Any] | None:
    """若配置了 SOFA_BOARD_PUSH_URL，POST 到线上 /api/tennis-board/{full|live}。"""
    if not PUSH_URL:
        return None
    import urllib.error
    import urllib.request

    path = "full" if mode == "full" else "live"
    url = f"{PUSH_URL}/api/tennis-board/{path}"
    body = json.dumps({"bundle": bundle}, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Cloudflare 会拦 Python-urllib 默认 UA
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
    }
    if PUSH_TOKEN:
        headers["Authorization"] = f"Bearer {PUSH_TOKEN}"
        headers["X-Board-Token"] = PUSH_TOKEN
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else {}
            if not isinstance(data, dict):
                return {"ok": False, "error": "invalid push response"}
            data.setdefault("via", "http")
            data.setdefault("push_url", url)
            return data
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(detail) if detail else {}
            err = parsed.get("error") if isinstance(parsed, dict) else detail
        except Exception:
            err = str(exc)
        return {"ok": False, "error": err or f"HTTP {exc.code}", "push_url": url}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "push_url": url}


def sync_full_to_redis(*, force: bool = False, force_ranks: bool = False) -> dict[str, Any]:
    """全量推：优先 HTTP 到线上；否则写 REDIS_URL。"""
    used_cache = False
    if not force and not force_ranks:
        with _cache_lock:
            board = _cache.get("data")
        if board and board.get("ok") and (board.get("events") is not None):
            used_cache = True
        else:
            board = None
    else:
        board = None
    if board is None:
        board = get_board(force=True, force_ranks=force_ranks)
    if not board.get("ok"):
        return {"ok": False, "error": board.get("error") or "board failed", "board": board}
    collect = _board_to_collect(board)
    bundle = build_bundle_payload(collect)
    http_out = _push_http("full", bundle)
    if http_out is not None:
        return {
            "ok": bool(http_out.get("ok")),
            "mode": "full",
            "via": "http",
            "cached": used_cache,
            "date": collect.get("date"),
            "events": len(collect.get("events") or []),
            "summary": board.get("summary"),
            "redis": http_out,
            "redis_url_host": PUSH_URL,
            "error": None if http_out.get("ok") else (http_out.get("error") or "http push failed"),
        }
    redis_out = persist_collect_bundle(collect)
    redis_info = redis_out.get("redis") if isinstance(redis_out.get("redis"), dict) else {}
    return {
        "ok": bool(redis_info.get("ok")),
        "mode": "full",
        "via": "redis",
        "cached": used_cache,
        "date": collect.get("date"),
        "events": len(collect.get("events") or []),
        "summary": board.get("summary"),
        "redis": redis_info,
        "bundle_file": redis_out.get("bundle_file"),
        "redis_url_host": _redis_host_public(),
        "error": None
        if redis_info.get("ok")
        else (redis_info.get("error") or redis_info.get("reason") or "redis write failed"),
    }


def sync_live_to_redis(*, force: bool = False) -> dict[str, Any]:
    """高频推：优先 HTTP 到线上；否则写 REDIS_URL inplay。"""
    used_cache = False
    live_res: dict[str, Any] | None = None
    if force:
        live_res = refresh_live_board(force=True)
        if not live_res.get("ok"):
            return {"ok": False, "error": live_res.get("error") or "live refresh failed", "live": live_res}
        live_events = list(live_res.get("live") or [])
        with _cache_lock:
            board = _cache.get("data") or {}
    else:
        with _cache_lock:
            board = _cache.get("data") or {}
        live_events = list(board.get("live") or [])
        if not live_events and not board.get("ok"):
            live_res = refresh_live_board(force=True)
            if not live_res.get("ok"):
                return {"ok": False, "error": live_res.get("error") or "live refresh failed", "live": live_res}
            live_events = list(live_res.get("live") or [])
            with _cache_lock:
                board = _cache.get("data") or {}
        else:
            used_cache = True
    live_events = [_normalize_match_scores(dict(e)) for e in live_events if isinstance(e, dict)]
    for ev in live_events:
        _stamp_player_ranks(ev)
    collect = {
        "date": board.get("date") or today_bj(),
        "events": live_events,
        "top100": False,
        "top_rank_max": TOP_N,
        "rankingsByPlayer": _rankings_by_player(board) if isinstance(board, dict) else {},
        "filter_conditions": {"tier": "500_1000", "live_only": True},
    }
    bundle = build_live_bundle_payload(collect)
    http_out = _push_http("live", bundle)
    if http_out is not None:
        return {
            "ok": bool(http_out.get("ok")),
            "mode": "live",
            "via": "http",
            "cached": used_cache,
            "date": collect.get("date"),
            "events": len(live_events),
            "summary": (live_res or {}).get("summary") if isinstance(live_res, dict) else board.get("summary"),
            "redis": http_out,
            "redis_url_host": PUSH_URL,
            "live_refreshed_at": (live_res or {}).get("live_refreshed_at") if isinstance(live_res, dict) else None,
            "error": None if http_out.get("ok") else (http_out.get("error") or "http push failed"),
        }
    redis_out = persist_live_collect(collect)
    redis_info = redis_out.get("redis") if isinstance(redis_out.get("redis"), dict) else {}
    return {
        "ok": bool(redis_info.get("ok")),
        "mode": "live",
        "via": "redis",
        "cached": used_cache,
        "date": collect.get("date"),
        "events": len(live_events),
        "summary": (live_res or {}).get("summary") if isinstance(live_res, dict) else board.get("summary"),
        "redis": redis_info,
        "bundle_file": redis_out.get("bundle_file"),
        "live_refreshed_at": (live_res or {}).get("live_refreshed_at") if isinstance(live_res, dict) else None,
        "redis_url_host": _redis_host_public(),
        "error": None if redis_info.get("ok") else (redis_info.get("error") or redis_info.get("reason") or "redis write failed"),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[board] {self.address_string()} {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_sync_token(self) -> bool:
        # 本机访问不校验；外网才要求 SOFA_BOARD_SYNC_TOKEN
        peer = (self.client_address[0] if self.client_address else "") or ""
        if peer in {"127.0.0.1", "::1", "localhost"}:
            return True
        if not SYNC_TOKEN:
            return True
        qs = parse_qs(urlparse(self.path).query)
        got = (qs.get("token") or [""])[0].strip()
        if not got:
            got = (self.headers.get("X-Board-Token") or "").strip()
        return got == SYNC_TOKEN

    def _json_handler(self, fn: Any, *, ok_only_200: bool = False) -> None:
        try:
            data = fn()
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            # sync 接口失败也 200，让前端能读到 redis error，而不是只显示 HTTP 503
            code = 200 if (data.get("ok") or ok_only_200) else 503
            self._send(code, payload, "application/json; charset=utf-8")
        except Exception as exc:
            err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self._send(500, err, "application/json; charset=utf-8")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in {"/api/health", "/api/health/"}:
            self._send(200, b'{"ok":true}', "application/json; charset=utf-8")
            return
        if path in {"/api/sync/full", "/api/sync/full/"}:
            if not self._check_sync_token():
                self._send(401, b'{"ok":false,"error":"unauthorized"}', "application/json; charset=utf-8")
                return
            qs = parse_qs(urlparse(self.path).query)
            force = (qs.get("refresh") or [""])[0] in {"1", "true", "yes"}
            force_ranks = (qs.get("ranks") or [""])[0] in {"1", "true", "yes"}
            self._json_handler(lambda: sync_full_to_redis(force=force, force_ranks=force_ranks), ok_only_200=True)
            return
        if path in {"/api/sync/live", "/api/sync/live/"}:
            if not self._check_sync_token():
                self._send(401, b'{"ok":false,"error":"unauthorized"}', "application/json; charset=utf-8")
                return
            qs = parse_qs(urlparse(self.path).query)
            force = (qs.get("refresh") or [""])[0] in {"1", "true", "yes"}
            self._json_handler(lambda: sync_live_to_redis(force=force), ok_only_200=True)
            return
        if path in {"/api/live", "/api/live/"}:
            qs = parse_qs(urlparse(self.path).query)
            force = (qs.get("refresh") or [""])[0] in {"1", "true", "yes"}
            try:
                data = refresh_live_board(force=force)
                payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
                code = 200 if data.get("ok") else 503
                self._send(code, payload, "application/json; charset=utf-8")
            except Exception as exc:
                err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                self._send(500, err, "application/json; charset=utf-8")
            return
        if path in {"/api/board", "/api/board/"}:
            qs = parse_qs(urlparse(self.path).query)
            refresh = (qs.get("refresh") or [""])[0].lower()
            force = refresh in {"1", "true", "yes"}
            force_ranks = refresh in {"ranks", "full"}
            try:
                data = get_board(force=force or force_ranks, force_ranks=force_ranks)
                payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
                self._send(200, payload, "application/json; charset=utf-8")
            except Exception as exc:
                err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                self._send(500, err, "application/json; charset=utf-8")
            return

        rel = path.lstrip("/") or "index.html"
        file_path = (ROOT / rel).resolve()
        if not str(file_path).startswith(str(ROOT)) or not file_path.is_file():
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        data = file_path.read_bytes()
        ctype = "text/html; charset=utf-8"
        if file_path.suffix == ".js":
            ctype = "application/javascript; charset=utf-8"
        elif file_path.suffix == ".css":
            ctype = "text/css; charset=utf-8"
        self._send(200, data, ctype)

    def do_POST(self) -> None:
        """全量/高频同步也支持 POST。"""
        path = urlparse(self.path).path
        if path in {"/api/sync/full", "/api/sync/full/", "/api/sync/live", "/api/sync/live/"}:
            self.do_GET()
            return
        self._send(404, b"not found", "text/plain; charset=utf-8")


def main() -> None:
    warm_startup()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"tennis-live-board http://{HOST}:{PORT}")
    print(f"  sync full → GET/POST /api/sync/full")
    print(f"  sync live → GET/POST /api/sync/live")
    if PUSH_URL:
        print(f"  push via HTTP → {PUSH_URL}/api/tennis-board/{{full,live}}")
        print(f"  auto-push → {'ON' if AUTO_PUSH else 'OFF'}")
    else:
        print(f"  push via Redis → {_redis_host_public() or '(未配置 REDIS_URL)'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
