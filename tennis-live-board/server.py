#!/usr/bin/env python3
"""本地看板：静态页 + /api/board（ATP/WTA Top100 + 赛事）。"""
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

from tm.bundle import parse_player_rank_detail, slim_event  # noqa: E402
from tm.clients.sofascore import _event_score  # noqa: E402
from tm.clients.sofascore_mobile import SofascoreMobileClient  # noqa: E402
from tm.collectors.events import today_bj  # noqa: E402
from tm.collectors.rankings import (  # noqa: E402
    RANK_PATHS,
    attach_matches,
    board_player_maps,
    event_matches_board,
    lookup_player_rank,
    name_keys,
    norm_name,
)
from tm.enrich import _event_tour  # noqa: E402

HOST = os.environ.get("SOFA_BOARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("SOFA_BOARD_PORT", "8765"))
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


def _fetch_day_events(client: SofascoreMobileClient, match_date: str, *, max_pages: int = 2) -> list[dict]:
    out: list[dict] = []
    for page in range(max_pages):
        data = client._api_get(f"sport/tennis/{match_date}/events/{page}")
        batch = data.get("events") or []
        if not batch:
            break
        out.extend(batch)
        if not data.get("hasNextPage"):
            break
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
            if not event_matches_board(ev, filter_board):
                continue
            slim = slim_event(ev)
            slim["scoreText"] = _event_score(ev)
            slim["tour"] = _event_tour(ev)
            _enrich_event_ranks(slim, rank_board)
            live_slim.append(slim)

        by_id: dict[int, dict[str, Any]] = {
            int(e["id"]): e
            for e in (base.get("events") or [])
            if e.get("id") is not None and not _is_live(e)
        }
        for ev in live_slim:
            by_id[int(ev["id"])] = ev
        events = sorted(
            by_id.values(),
            key=lambda e: (0 if _is_live(e) else 1, e.get("startTimestamp") or 0, e.get("id") or 0),
        )
        live_events = [e for e in events if _is_live(e)]

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
            "total_events": len(events),
        }
        updated["live_refreshed_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        with _cache_lock:
            _cache["data"] = updated
        _live_cache["at"] = time.time()

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
        try:
            for ev in client.get_live_tennis_events().get("events") or []:
                eid = ev.get("id")
                if eid is not None:
                    raw_by_id[int(eid)] = ev
        except Exception as exc:
            msg = f"live: {exc}"
            error = f"{error}; {msg}" if error else msg
        try:
            for ev in _fetch_day_events(client, match_date):
                eid = ev.get("id")
                if eid is not None:
                    raw_by_id[int(eid)] = ev
        except Exception as exc:
            msg = f"schedule: {exc}"
            error = f"{error}; {msg}" if error else msg

        filtered = [ev for ev in raw_by_id.values() if event_matches_board(ev, board)]
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

    return _json_safe(
        {
            "ok": True,
            "date": match_date,
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "elapsed_sec": round(time.time() - started, 2),
            "filter": "top100_any",
            "top_rank_max": TOP_N,
            "filter_note": "至少一方在 ATP/WTA 前100",
            "ranks_refreshed": ranks_refreshed,
            "rank_cache_sec": RANK_CACHE_SEC,
            "error": error,
            "summary": {
                "atp_players": len(board.get("atp") or []),
                "wta_players": len(board.get("wta") or []),
                "total_events": len(slim_events),
                "live_events": len(live_events),
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
        return data


def warm_startup() -> None:
    disk = _load_disk_board()
    if disk:
        with _cache_lock:
            _cache["data"] = disk
            _cache["at"] = time.time() - CACHE_SEC - 1
        print(f"[board] loaded disk cache · events={len(disk.get('events') or [])}")
    threading.Thread(target=refresh_board_async, daemon=True).start()


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

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in {"/api/health", "/api/health/"}:
            self._send(200, b'{"ok":true}', "application/json; charset=utf-8")
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


def main() -> None:
    warm_startup()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"tennis-live-board http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
