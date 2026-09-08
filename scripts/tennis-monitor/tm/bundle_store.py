"""Daily bundle 落盘 + Redis 写入（与 server tennisCache.js 键名一致）。"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tm.collectors.events import today_bj
from tm.env import MONITOR_ROOT

OUTPUT_DIR = MONITOR_ROOT / "output"
BUNDLE_KEY = "tennis:bundle:full"
META_KEY = "tennis:bundle:fetched_at"
INPLAY_BUNDLE_KEY = "tennis:bundle:inplay"
INPLAY_META_KEY = "tennis:bundle:inplay:fetched_at"
# collect.py / collect_live.py 写入标识（与 server 路由 dataSource 一致）
DATA_SOURCE_COLLECT = "collect"
DATA_SOURCE_COLLECT_LIVE = "collect_live"
TTL_SEC = int(os.environ.get("TENNIS_CACHE_TTL_SEC", "86400"))
_TOP_N_DEFAULT = int(os.environ.get("SOFA_TOP_N", "100"))
_LIVE_TYPES = frozenset({"inprogress", "live", "interrupted"})


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


def write_daily_bundle_file(bundle: dict[str, Any]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"daily_bundle_{bundle.get('date') or today_bj()}.json"
    path.write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
    bundle["bundle_file"] = path.name
    return path


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
        return {
            "ok": True,
            "key": BUNDLE_KEY,
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
        "filter_conditions": collect.get("filter_conditions"),
        "update": {"message": f"collect_live → {INPLAY_BUNDLE_KEY} · {len(live_events)} live"},
        "message": f"collect_live→redis · {len(live_events)} live",
    }


def write_live_bundle_redis(bundle: dict[str, Any]) -> dict[str, Any]:
    """写入盘中采集 Redis 键 tennis:bundle:inplay（与 server tennisInplayCache.js 一致）。"""
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


def persist_collect_bundle(collect: dict[str, Any]) -> dict[str, Any]:
    """写 output/daily_bundle_*.json 并同步 Redis 全量包。"""
    bundle = build_bundle_payload(collect)
    path = write_daily_bundle_file(bundle)
    redis_result = write_bundle_redis(bundle)
    return {
        "bundle_file": path.name,
        "bundle_path": str(path),
        "events": bundle.get("events"),
        "redis": redis_result,
    }


def persist_live_collect(collect: dict[str, Any]) -> dict[str, Any]:
    """仅写入 collect_live 独立 Redis（tennis:bundle:inplay），不触碰 tennis:bundle:full。"""
    match_date = collect.get("date") or today_bj()
    live_bundle = build_live_bundle_payload(collect)
    live_path = OUTPUT_DIR / f"daily_live_bundle_{match_date}.json"
    live_path.write_text(json.dumps(live_bundle, ensure_ascii=False), encoding="utf-8")
    live_bundle["bundle_file"] = live_path.name
    redis_result = write_live_bundle_redis(live_bundle)
    return {
        "bundle_file": live_path.name,
        "bundle_path": str(live_path),
        "events": len(collect.get("events") or []),
        "redis": redis_result,
    }
