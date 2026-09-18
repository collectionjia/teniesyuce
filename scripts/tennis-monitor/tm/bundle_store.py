"""Daily bundle 落盘 + Redis 写入（与 server tennisCache.js 键名一致）。"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tm.collectors.events import today_bj
from tm.env import MONITOR_ROOT

OUTPUT_DIR = Path(
    (os.environ.get("TENNIS_OUTPUT_DIR") or "").strip() or str(MONITOR_ROOT / "output")
)
BUNDLE_KEY = "tennis:bundle:full"
META_KEY = "tennis:bundle:fetched_at"
INPLAY_BUNDLE_KEY = "tennis:bundle:inplay"
INPLAY_META_KEY = "tennis:bundle:inplay:fetched_at"
PREMATCH_BUNDLE_KEY = "tennis:bundle:prematch"
PREMATCH_META_KEY = "tennis:bundle:prematch:fetched_at"
SETTLED_BUNDLE_KEY = "tennis:bundle:settled"
SETTLED_META_KEY = "tennis:bundle:settled:fetched_at"
META_TODAY_KEY = "tennis:bundle:meta:today"
# collect.py / collect_live.py 写入标识（与 server 路由 dataSource 一致）
DATA_SOURCE_COLLECT = "collect"
DATA_SOURCE_COLLECT_LIVE = "collect_live"
TTL_SEC = int(os.environ.get("TENNIS_CACHE_TTL_SEC", "86400"))
_TOP_N_DEFAULT = int(os.environ.get("SOFA_TOP_N", "100"))
_LIVE_TYPES = frozenset({"inprogress", "live", "interrupted"})
_ENDED_TYPES = frozenset({"finished", "ended", "closed", "retired", "walkover"})


def is_ended_match(match: dict[str, Any] | None) -> bool:
    """盘中场次是否已完赛（用于 tick 迁入 settled）。"""
    if not match:
        return False
    st = str(match.get("statusType") or "").lower().strip()
    if st in _ENDED_TYPES:
        return True
    # 少数源把完赛写在 status 文案里
    desc = str(match.get("status") or "").lower()
    return any(x in desc for x in ("finished", "ended", "retired", "walkover", "已结束", "完赛"))


def group_scheduled(events: list[dict]) -> dict[str, Any]:
    groups: dict[str, list[dict]] = {}
    for ev in events:
        key = ev.get("tournament") or ev.get("tournamentShort") or "Other"
        groups.setdefault(str(key), []).append(ev)
    tournaments = [{"name": name, "events": items} for name, items in groups.items()]
    return {
        "tournaments": tournaments,
        "tournamentCount": len(tournaments),
        "eventCount": len(events),
    }


def build_bundle_payload(collect: dict[str, Any]) -> dict[str, Any]:
    events = list(collect.get("events") or [])
    live = [e for e in events if str(e.get("statusType") or "").lower() in _LIVE_TYPES]
    live_group = group_scheduled(live)
    match_date = collect.get("date") or today_bj()
    fetched_at = datetime.now(timezone.utc).isoformat()
    data_filter = "top100" if collect.get("top100") else "tier"
    event_count = len(events)
    rankings_board = collect.get("rankingsBoard") or collect.get("top100Board")
    # collect 里 top100 可能是 bool；榜单对象在 rankingsBoard
    top100_board = None
    if isinstance(rankings_board, dict) and (rankings_board.get("atp") or rankings_board.get("wta")):
        top100_board = {
            "atp": rankings_board.get("atp") or [],
            "wta": rankings_board.get("wta") or [],
            "summary": rankings_board.get("summary") or {
                "total_matches": event_count,
                "atp_players": len(rankings_board.get("atp") or []),
                "wta_players": len(rankings_board.get("wta") or []),
            },
        }
    elif isinstance(collect.get("top100"), dict) and (
        collect["top100"].get("atp") or collect["top100"].get("wta")
    ):
        top100_board = collect["top100"]
    return {
        "ok": True,
        "sport": "tennis",
        "date": match_date,
        "fetched_at": fetched_at,
        "filter": data_filter,
        "dataFilter": data_filter,
        "top_rank_max": collect.get("top_rank_max") or (_TOP_N_DEFAULT if collect.get("top100") else None),
        "exclude_ended": True,
        "source": "tennis-collect",
        "upstream": "ipwo",
        "dataSource": DATA_SOURCE_COLLECT,
        "collectScript": "collect",
        "scheduled": group_scheduled(events),
        "live": {
            "matches": live,
            "tournaments": live_group["tournaments"],
            "tournamentCount": live_group["tournamentCount"],
            "eventCount": len(live),
        },
        "rankingsByPlayer": collect.get("rankingsByPlayer") or {},
        "oddsByEvent": collect.get("oddsByEvent") or {},
        "eloByEvent": collect.get("eloByEvent") or {},
        "polymarketByEvent": collect.get("polymarketByEvent") or {},
        "theOddsApiByEvent": collect.get("theOddsApiByEvent") or {},
        "birthYearByPlayer": collect.get("birthYearByPlayer") or {},
        "top100": top100_board,
        "rankingsBoard": top100_board,
        "requests": collect.get("requests"),
        "timing": collect.get("timing"),
        "events": event_count,
        "serverTime": int(datetime.now(timezone.utc).timestamp()),
        "update": {"message": f"collect.py → Redis · {event_count} events"},
        "member": True,
        "message": f"collect→redis · {event_count} events",
    }


def _load_redis_url_from_server_env() -> None:
    if (os.environ.get("REDIS_URL") or "").strip():
        return
    server_env = MONITOR_ROOT.parent.parent / "server" / ".env"
    if not server_env.exists():
        return
    for raw in server_env.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        if key.strip() == "REDIS_URL":
            os.environ["REDIS_URL"] = val.strip().strip("\r")
            return


def write_daily_bundle_file(bundle: dict[str, Any]) -> Path | None:
    try:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        path = OUTPUT_DIR / f"daily_bundle_{bundle.get('date') or today_bj()}.json"
        path.write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
        bundle["bundle_file"] = path.name
        return path
    except OSError as exc:
        print(f"[bundle] output 落盘跳过（{exc}），继续写 Redis")
        return None


def write_bundle_redis(bundle: dict[str, Any]) -> dict[str, Any]:
    _load_redis_url_from_server_env()
    url = (os.environ.get("REDIS_URL") or "").strip()
    if not url:
        return {"ok": False, "skipped": True, "reason": "未配置 REDIS_URL（可在 monitor.env 或 server/.env 填写）"}
    try:
        import redis
    except ImportError:
        return {"ok": False, "error": "缺少 redis 包，请 pip install redis"}
    try:
        client = redis.from_url(url, decode_responses=True)
        payload = json.dumps(bundle, ensure_ascii=False)
        client.set(BUNDLE_KEY, payload, ex=TTL_SEC)
        client.set(META_KEY, str(bundle.get("fetched_at") or ""), ex=TTL_SEC)
        # 附属 meta（三桶共享）
        meta = {
            "fetched_at": bundle.get("fetched_at"),
            "date": bundle.get("date"),
            "rankingsByPlayer": bundle.get("rankingsByPlayer") or {},
            "oddsByEvent": bundle.get("oddsByEvent") or {},
            "polymarketByEvent": bundle.get("polymarketByEvent") or {},
            "eloByEvent": bundle.get("eloByEvent") or {},
            "birthYearByPlayer": bundle.get("birthYearByPlayer") or {},
        }
        client.set(META_TODAY_KEY, json.dumps(meta, ensure_ascii=False), ex=TTL_SEC)
        # 按状态粗拆三桶（强者 Top100 由 Node split 再精修；此处保证键存在）
        events = []
        for t in (bundle.get("scheduled") or {}).get("tournaments") or []:
            for e in t.get("events") or []:
                events.append(e)
        for e in (bundle.get("live") or {}).get("matches") or []:
            events.append(e)
        live_types = _LIVE_TYPES
        prematch_ev, inplay_ev, settled_ev = [], [], []
        for e in events:
            st = str(e.get("statusType") or "").lower()
            if st in live_types:
                inplay_ev.append(e)
            elif is_ended_match(e):
                settled_ev.append(e)
            else:
                prematch_ev.append(e)

        def _shell(matches: list, source: str, as_live: bool) -> dict:
            g = group_scheduled(matches)
            return {
                **{k: bundle.get(k) for k in (
                    "ok", "sport", "date", "fetched_at", "rankingsByPlayer",
                    "oddsByEvent", "polymarketByEvent", "eloByEvent", "birthYearByPlayer",
                )},
                "source": source,
                "scheduled": {"tournaments": [], "tournamentCount": 0, "eventCount": 0} if as_live or source.endswith("settled") else g,
                "live": {
                    "matches": matches if (as_live or source.endswith("settled")) else [],
                    "tournaments": g["tournaments"] if (as_live or source.endswith("settled")) else [],
                    "tournamentCount": g["tournamentCount"] if (as_live or source.endswith("settled")) else 0,
                    "eventCount": len(matches) if (as_live or source.endswith("settled")) else 0,
                } if (as_live or source.endswith("settled")) else {
                    "matches": [],
                    "tournaments": [],
                    "tournamentCount": 0,
                    "eventCount": 0,
                },
                "events": len(matches),
                "serverTime": bundle.get("serverTime"),
                "message": f"{source} · {len(matches)}",
            }

        pre = _shell(prematch_ev, "tennis-prematch", False)
        pre["scheduled"] = group_scheduled(prematch_ev)
        inp = _shell(inplay_ev, "tennis-inplay", True)
        stl = _shell(settled_ev, "tennis-settled", True)
        client.set(PREMATCH_BUNDLE_KEY, json.dumps(pre, ensure_ascii=False), ex=TTL_SEC)
        client.set(PREMATCH_META_KEY, str(bundle.get("fetched_at") or ""), ex=TTL_SEC)
        client.set(INPLAY_BUNDLE_KEY, json.dumps(inp, ensure_ascii=False), ex=TTL_SEC)
        client.set(INPLAY_META_KEY, str(bundle.get("fetched_at") or ""), ex=TTL_SEC)
        client.set(SETTLED_BUNDLE_KEY, json.dumps(stl, ensure_ascii=False), ex=TTL_SEC)
        client.set(SETTLED_META_KEY, str(bundle.get("fetched_at") or ""), ex=TTL_SEC)
        return {
            "ok": True,
            "key": BUNDLE_KEY,
            "also": [PREMATCH_BUNDLE_KEY, INPLAY_BUNDLE_KEY, SETTLED_BUNDLE_KEY, META_TODAY_KEY],
            "events": bundle.get("events"),
            "date": bundle.get("date"),
            "ttl_sec": TTL_SEC,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def build_live_bundle_payload(collect: dict[str, Any]) -> dict[str, Any]:
    """盘中采集专用包，写入 tennis:bundle:inplay（collect_live 独立键）。"""
    live_events = list(collect.get("events") or [])
    live_group = group_scheduled(live_events)
    match_date = collect.get("date") or today_bj()
    fetched_at = datetime.now(timezone.utc).isoformat()
    if collect.get("filter_conditions"):
        data_filter = "top100" if collect.get("top100") else "tier"
    else:
        data_filter = "live-simple"
    return {
        "ok": True,
        "sport": "tennis",
        "date": match_date,
        "fetched_at": fetched_at,
        "filter": data_filter,
        "dataFilter": data_filter,
        "top_rank_max": collect.get("top_rank_max"),
        "exclude_ended": True,
        "source": "tennis-collect-live",
        "upstream": "ipwo",
        "dataSource": DATA_SOURCE_COLLECT_LIVE,
        "collectScript": "collect_live",
        "scheduled": {
            "tournaments": [],
            "tournamentCount": 0,
            "eventCount": 0,
        },
        "live": {
            "matches": live_events,
            "tournaments": live_group["tournaments"],
            "tournamentCount": live_group["tournamentCount"],
            "eventCount": len(live_events),
        },
        "rankingsByPlayer": collect.get("rankingsByPlayer") or {},
        "oddsByEvent": collect.get("oddsByEvent") or {},
        "eloByEvent": collect.get("eloByEvent") or {},
        "polymarketByEvent": collect.get("polymarketByEvent") or {},
        "theOddsApiByEvent": collect.get("theOddsApiByEvent") or {},
        "birthYearByPlayer": collect.get("birthYearByPlayer") or {},
        "requests": collect.get("requests"),
        "timing": collect.get("timing"),
        "events": len(live_events),
        "serverTime": int(datetime.now(timezone.utc).timestamp()),
        "tick_at": fetched_at,
        "score_updated_at": fetched_at,
        "odds_updated_at": fetched_at,
        "filter_conditions": collect.get("filter_conditions"),
        "update": {"message": f"collect_live → {INPLAY_BUNDLE_KEY} · {len(live_events)} live"},
        "message": f"collect_live→redis · {len(live_events)} live",
    }


def _redis_client():
    """返回 (client|None, error_dict|None)。"""
    _load_redis_url_from_server_env()
    url = (os.environ.get("REDIS_URL") or "").strip()
    if not url:
        return None, {
            "ok": False,
            "skipped": True,
            "reason": "未配置 REDIS_URL（可在 monitor.env 或 server/.env 填写）",
        }
    try:
        import redis
    except ImportError:
        return None, {"ok": False, "error": "缺少 redis 包，请 pip install redis"}
    try:
        return redis.from_url(url, decode_responses=True), None
    except Exception as exc:
        return None, {"ok": False, "error": str(exc)}


def read_live_bundle_redis() -> dict[str, Any]:
    """读取 tennis:bundle:inplay；成功时 {ok, bundle}，失败时带 error/skipped。"""
    client, err = _redis_client()
    if err:
        return err
    try:
        raw = client.get(INPLAY_BUNDLE_KEY)
        if not raw:
            return {"ok": True, "bundle": None, "key": INPLAY_BUNDLE_KEY}
        return {"ok": True, "bundle": json.loads(raw), "key": INPLAY_BUNDLE_KEY}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def write_live_bundle_redis(bundle: dict[str, Any]) -> dict[str, Any]:
    """写入盘中采集 Redis 键 tennis:bundle:inplay（与 server tennisInplayCache.js 一致）。"""
    client, err = _redis_client()
    if err:
        return err
    try:
        payload = json.dumps(bundle, ensure_ascii=False)
        client.set(INPLAY_BUNDLE_KEY, payload, ex=TTL_SEC)
        client.set(INPLAY_META_KEY, str(bundle.get("fetched_at") or ""), ex=TTL_SEC)
        return {
            "ok": True,
            "key": INPLAY_BUNDLE_KEY,
            "events": bundle.get("events"),
            "date": bundle.get("date"),
            "ttl_sec": TTL_SEC,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def read_settled_bundle_redis() -> dict[str, Any]:
    """读取 tennis:bundle:settled。"""
    client, err = _redis_client()
    if err:
        return err
    try:
        raw = client.get(SETTLED_BUNDLE_KEY)
        if not raw:
            return {"ok": True, "bundle": None, "key": SETTLED_BUNDLE_KEY}
        return {"ok": True, "bundle": json.loads(raw), "key": SETTLED_BUNDLE_KEY}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def write_settled_bundle_redis(bundle: dict[str, Any]) -> dict[str, Any]:
    """写入盘后 Redis 键 tennis:bundle:settled。"""
    client, err = _redis_client()
    if err:
        return err
    try:
        payload = json.dumps(bundle, ensure_ascii=False)
        client.set(SETTLED_BUNDLE_KEY, payload, ex=TTL_SEC)
        client.set(SETTLED_META_KEY, str(bundle.get("fetched_at") or ""), ex=TTL_SEC)
        return {
            "ok": True,
            "key": SETTLED_BUNDLE_KEY,
            "events": bundle.get("events"),
            "date": bundle.get("date"),
            "ttl_sec": TTL_SEC,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _empty_settled_shell(*, date: str | None = None) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "ok": True,
        "sport": "tennis",
        "source": "tennis-settled",
        "date": date or today_bj().isoformat(),
        "fetched_at": now,
        "scheduled": {"tournaments": [], "tournamentCount": 0, "eventCount": 0},
        "live": {"matches": [], "tournaments": [], "tournamentCount": 0, "eventCount": 0},
        "rankingsByPlayer": {},
        "oddsByEvent": {},
        "polymarketByEvent": {},
        "eloByEvent": {},
        "birthYearByPlayer": {},
        "events": 0,
        "serverTime": int(datetime.now(timezone.utc).timestamp()),
        "message": "tick 迁入盘后",
        "update": {"message": "refresh_inplay → tennis:bundle:settled"},
    }


def merge_finished_into_settled(
    finished: list[dict[str, Any]],
    *,
    from_bundle: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """把完赛场次并入 settled 包（按 event id 去重，后写覆盖），并迁入相关 meta。"""
    if not finished:
        return {"ok": True, "moved": 0, "skipped": True}

    loaded = read_settled_bundle_redis()
    if not loaded.get("ok"):
        return {"ok": False, "error": loaded.get("error") or loaded.get("reason") or "settled read failed"}

    settled = loaded.get("bundle")
    if not isinstance(settled, dict):
        settled = _empty_settled_shell(date=(from_bundle or {}).get("date"))

    live = settled.get("live") if isinstance(settled.get("live"), dict) else {}
    existing = list(live.get("matches") or [])
    by_id: dict[int, dict[str, Any]] = {}
    for m in existing:
        if m.get("id") is not None:
            by_id[int(m["id"])] = m
    for m in finished:
        if m.get("id") is None:
            continue
        by_id[int(m["id"])] = m

    merged = list(by_id.values())
    grouped = group_scheduled(merged)
    live["matches"] = merged
    live["tournaments"] = grouped["tournaments"]
    live["tournamentCount"] = grouped["tournamentCount"]
    live["eventCount"] = len(merged)
    settled["live"] = live
    settled["events"] = len(merged)
    settled["source"] = "tennis-settled"
    settled["ok"] = True
    now = datetime.now(timezone.utc).isoformat()
    settled["fetched_at"] = now
    settled["tick_at"] = now
    settled["serverTime"] = int(datetime.now(timezone.utc).timestamp())
    settled["collectScript"] = "refresh_inplay"
    settled["message"] = f"settled · {len(merged)}"
    settled["update"] = {"message": f"refresh_inplay 迁入 · +{len(finished)} → {len(merged)}"}

    # 从盘中包迁入对应 meta，避免盘后页缺赔率/推荐依据
    src = from_bundle if isinstance(from_bundle, dict) else {}
    finished_ids = {str(int(m["id"])) for m in finished if m.get("id") is not None}
    for meta_key in ("oddsByEvent", "polymarketByEvent", "eloByEvent"):
        dst_map = settled.get(meta_key)
        if not isinstance(dst_map, dict):
            dst_map = {}
            settled[meta_key] = dst_map
        src_map = src.get(meta_key)
        if not isinstance(src_map, dict):
            continue
        for kid, val in src_map.items():
            if str(kid) in finished_ids:
                dst_map[str(kid)] = val

    for rk in ("rankingsByPlayer", "birthYearByPlayer"):
        if isinstance(src.get(rk), dict) and src[rk]:
            dst = settled.get(rk) if isinstance(settled.get(rk), dict) else {}
            dst.update(src[rk])
            settled[rk] = dst

    written = write_settled_bundle_redis(settled)
    if not written.get("ok"):
        return {"ok": False, "error": written.get("error") or written.get("reason") or "settled write failed"}
    return {
        "ok": True,
        "moved": len(finished),
        "settled_matches": len(merged),
        "key": SETTLED_BUNDLE_KEY,
    }


def persist_collect_bundle(collect: dict[str, Any]) -> dict[str, Any]:
    """写 output/daily_bundle_*.json 并同步 Redis 全量包。"""
    bundle = build_bundle_payload(collect)
    path = write_daily_bundle_file(bundle)
    redis_result = write_bundle_redis(bundle)
    return {
        "bundle_file": path.name if path else None,
        "bundle_path": str(path) if path else None,
        "events": bundle.get("events"),
        "redis": redis_result,
    }


def persist_live_collect(collect: dict[str, Any]) -> dict[str, Any]:
    """仅写入 collect_live 独立 Redis（tennis:bundle:inplay），不触碰 tennis:bundle:full。"""
    match_date = collect.get("date") or today_bj()
    live_bundle = build_live_bundle_payload(collect)
    live_path: Path | None = None
    try:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        live_path = OUTPUT_DIR / f"daily_live_bundle_{match_date}.json"
        live_path.write_text(json.dumps(live_bundle, ensure_ascii=False), encoding="utf-8")
        live_bundle["bundle_file"] = live_path.name
    except OSError as exc:
        print(f"[bundle] live output 落盘跳过（{exc}），继续写 Redis")
    redis_result = write_live_bundle_redis(live_bundle)
    return {
        "bundle_file": live_path.name if live_path else None,
        "bundle_path": str(live_path) if live_path else None,
        "events": len(collect.get("events") or []),
        "redis": redis_result,
    }
