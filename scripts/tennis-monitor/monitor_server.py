#!/usr/bin/env python3
from __future__ import annotations

import copy
import gc
import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from events_collector import today_bj
from live_collector import run_live_sync
from monitor_env import load_monitor_env
from ipwo_proxy import proxy_status_public
from top20_collector import build_top20_response, get_cached_top20_payload, restore_top20_board
from top100_collector import build_top100_response, collect_top100_snapshot, restore_top100_board

load_monitor_env()

APP_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = APP_DIR / "output"
LOG_DIR = APP_DIR / "logs"
SCHEDULE_FILE = APP_DIR / "config" / "schedule.json"
HOST = os.environ.get("SOFA_MONITOR_HOST", "0.0.0.0")
PORT = int(os.environ.get("SOFA_MONITOR_PORT", "9004"))
TOKEN = (os.environ.get("SOFA_MONITOR_TOKEN") or "sofascore-monitor-2026").strip()
ALLOWED_COLLECT_INTERVALS = (2, 4, 6, 12)
LIVE_INTERVAL_SEC = int(os.environ.get("LIVE_POLL_INTERVAL_SEC", "300"))
YUCE_SERVER_CONTAINER = (os.environ.get("YUCE_SERVER_CONTAINER") or "yuce-server-1").strip()

_lock = threading.Lock()
_running = False
_last_run: dict[str, Any] = {"status": "idle"}
_live_lock = threading.Lock()
_live_running = False
_last_live: dict[str, Any] = {"status": "idle", "events": []}
_top20_cache: dict[str, Any] = {"loading": False}
_top100_lock = threading.Lock()
_top100_running = False
_last_top100: dict[str, Any] = {"status": "idle"}
_top100_cache: dict[str, Any] = {"loading": False}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _auth_ok(handler: BaseHTTPRequestHandler) -> bool:
    header = handler.headers.get("Authorization") or ""
    token = ""
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
    qs = parse_qs(urlparse(handler.path).query)
    token = token or (qs.get("token") or [""])[0]
    return token == TOKEN


def _friendly_error(exc: Exception | str) -> str:
    msg = str(exc).strip()
    low = msg.lower()
    if "431" in msg or "traffic limit" in low or "exceeds the sub user" in low:
        return "IPWO 代理子账号流量已用尽，请到 ipwo.net 充值或更换子账号"
    if "sub user status" in low or ("424" in msg and "407" in msg):
        return "IPWO 子账号状态异常（流量用尽或已停用），请到 ipwo.net 检查子账号"
    if "user status error" in low:
        return "IPWO 主账号状态异常（欠费/停用/密码错误），请检查 ipwo.net 或 monitor.env 密码"
    if "407" in msg or "418" in msg or "421" in msg or "auth info" in low or "password wrong" in low:
        return "IPWO 代理认证失败，请检查 monitor.env 用户名/密码/Zone（格式：用户名_custom_zone_US）"
    if "connect tunnel failed" in low and ("403" in msg or "407" in msg):
        return "IPWO 代理拒绝连接（账号状态或认证问题），并非直连 Sofascore；请到 ipwo.net 检查流量与密码"
    if "proxyerror" in low or "tunnel connection failed" in low or "unable to connect to proxy" in low:
        return "无法连接 IPWO 代理，请检查 monitor.env 与账号流量"
    if "timeout" in low or "timed out" in low:
        return "Sofascore 请求超时（代理或网络响应慢），请稍后重试"
    if "403" in msg or "forbidden" in low:
        return "Sofascore 拒绝访问（403），代理 IP 可能被风控，请更换 IPWO 地区或稍后重试"
    if "top20" in low and "失败" in msg:
        return msg
    if "collect already running" in low:
        return "已有采集任务在进行中，请稍后再试"
    if "live collect already running" in low:
        return "已有进行中比分拉取任务，请稍后再试"
    return msg


def _cron_lines() -> list[str]:
    try:
        raw = subprocess.check_output(["crontab", "-l"], text=True, stderr=subprocess.DEVNULL)
        return [ln for ln in raw.splitlines() if "monitor" in ln or "run_collect" in ln]
    except Exception:
        return []


def _read_schedule_config() -> dict[str, Any]:
    if SCHEDULE_FILE.exists():
        try:
            data = json.loads(SCHEDULE_FILE.read_text(encoding="utf-8"))
            hours = int(data.get("interval_hours") or 0)
            if hours in ALLOWED_COLLECT_INTERVALS:
                return {"interval_hours": hours}
        except Exception:
            pass
    return {"interval_hours": 6}


def _write_schedule_config(interval_hours: int) -> None:
    SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEDULE_FILE.write_text(
        json.dumps({"interval_hours": interval_hours}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _cron_expr_for_interval(hours: int) -> str:
    return f"0 */{hours} * * *"


def _apply_collect_schedule(interval_hours: int) -> list[str]:
    marker = "# sofascore-top100-collect"
    python = str(APP_DIR / "venv" / "bin" / "python")
    if not Path(python).exists():
        python = "python3"
    cron_line = (
        f"{_cron_expr_for_interval(interval_hours)} cd {APP_DIR} && {python} -c "
        "\"from monitor_server import _run_top100_collect; _run_top100_collect('cron')\""
    )
    try:
        raw = subprocess.check_output(["crontab", "-l"], text=True, stderr=subprocess.DEVNULL)
        lines = raw.splitlines()
    except Exception:
        lines = []
    kept: list[str] = []
    skip = False
    for line in lines:
        if marker in line or "sofascore-tennis-scraper" in line:
            skip = True
            continue
        if skip:
            if (
                line.startswith("CRON_TZ")
                or "monitor_server" in line
                or "run_collect" in line
                or "run_top100_collect" in line
            ):
                continue
            skip = False
        if "run_collect" in line or "run_top100_collect" in line or "monitor_server" in line:
            continue
        kept.append(line)
    block = [marker, "CRON_TZ=Asia/Shanghai", cron_line]
    payload = "\n".join(kept + ([""] if kept else []) + block).rstrip("\n") + "\n"
    subprocess.run(["crontab", "-"], input=payload, text=True, check=False)
    return block


def _schedule_payload() -> dict[str, Any]:
    hours = int(_read_schedule_config()["interval_hours"])
    return {
        "ok": True,
        "interval_hours": hours,
        "collect_target": "top100",
        "allowed_intervals": list(ALLOWED_COLLECT_INTERVALS),
        "cron_line": f"{_cron_expr_for_interval(hours)} top100-collect",
        "label": f"每 {hours} 小时 Top100",
    }


def _set_collect_schedule(interval_hours: int) -> dict[str, Any]:
    if interval_hours not in ALLOWED_COLLECT_INTERVALS:
        raise ValueError(f"interval_hours must be one of {ALLOWED_COLLECT_INTERVALS}")
    cron_block = _apply_collect_schedule(interval_hours)
    _write_schedule_config(interval_hours)
    return {
        "ok": True,
        "interval_hours": interval_hours,
        "cron": cron_block,
        "label": f"每 {interval_hours} 小时",
    }


def _group_scheduled(events: list[dict]) -> dict[str, Any]:
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


def _write_bundle(snapshot: dict[str, Any]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    events = snapshot.get("events") or []
    live = snapshot.get("live_matches") or [e for e in events if str(e.get("statusType") or "").lower() in {"inprogress", "live", "interrupted"}]
    payload = {
        "ok": True,
        "sport": "tennis",
        "date": snapshot.get("date") or today_bj(),
        "fetched_at": snapshot.get("fetched_at"),
        "filter": snapshot.get("filter") or "top20",
        "top_rank_max": snapshot.get("top_rank_max") or 20,
        "top20": snapshot.get("top20") or {},
        "scheduled": _group_scheduled(events),
        "live": {
            "matches": live,
            "tournaments": _group_scheduled(live).get("tournaments") or [],
            "tournamentCount": 0,
            "eventCount": len(live),
        },
        "rankingsByPlayer": snapshot.get("rankingsByPlayer") or {},
        "oddsByEvent": snapshot.get("oddsByEvent") or {},
        "eloByEvent": snapshot.get("eloByEvent") or {},
        "polymarketByEvent": snapshot.get("polymarketByEvent") or {},
        "theOddsApiByEvent": snapshot.get("theOddsApiByEvent") or {},
        "birthYearByPlayer": snapshot.get("birthYearByPlayer") or {},
        "events": len(events),
    }
    payload["live"]["tournamentCount"] = len(payload["live"]["tournaments"])
    path = OUTPUT_DIR / f"daily_bundle_{payload['date']}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _latest_bundle_full() -> dict[str, Any]:
    if not OUTPUT_DIR.exists():
        return {"ok": False, "error": "output dir missing"}
    bundles = sorted(OUTPUT_DIR.glob("daily_bundle_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not bundles:
        return {"ok": False, "error": "no bundle"}
    p = bundles[0]
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    if not isinstance(data, dict):
        return {"ok": False, "error": "invalid bundle"}
    data["ok"] = True
    data["bundle_file"] = p.name
    return data


def _latest_bundle_meta() -> dict[str, Any]:
    data = _latest_bundle_full()
    if not data.get("ok"):
        return data
    scheduled = data.get("scheduled") or {}
    return {
        "ok": True,
        "date": data.get("date"),
        "event_count": scheduled.get("eventCount") or data.get("events"),
        "bundle_file": data.get("bundle_file"),
        "fetched_at": data.get("fetched_at"),
    }


def _append_log(line: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    day = datetime.now().strftime("%Y%m%d")
    with (LOG_DIR / f"collect_{day}.log").open("a", encoding="utf-8") as f:
        f.write(line.rstrip() + "\n")


def _read_logs(lines: int = 120) -> dict[str, Any]:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(LOG_DIR.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    text = ""
    if files:
        raw = files[0].read_text(encoding="utf-8", errors="ignore").splitlines()
        text = "\n".join(raw[-lines:])
    return {"ok": True, "lines": text, "file": files[0].name if files else None}


def _write_mysql(snapshot: dict[str, Any], *, live_only: bool = False) -> dict[str, Any]:
    if os.environ.get("SOFA_WRITE_MYSQL", "1") != "1":
        return {"skipped": True}
    try:
        from db_writer import write_snapshot_to_mysql

        result = write_snapshot_to_mysql(snapshot, live_only=live_only)
        print(f"[mysql] {result}")
        return result
    except Exception as exc:
        print(f"[mysql] write failed: {exc}")
        return {"error": str(exc)}


def _refresh_server_redis(*, scope: str = "full") -> None:
    """采集 / live 轮询完成后通知 Node server 刷新 Redis。live 轮询只刷 live 缓存，减轻内存。"""
    all_scripts = [
        (
            "tennis",
            "require('./src/services/tennisFromMonitor')"
            ".refreshRedisFromMonitor({includeLive:true})"
            ".then(b=>console.log('[monitor→redis]',b.date,b.events,'live',b.live?.eventCount||0))"
            ".catch(e=>{console.error('[monitor→redis]',e.message);process.exit(0)})",
        ),
        (
            "live",
            "require('./src/services/tennisLiveFromMonitor')"
            ".refreshLiveBundleFromMonitor()"
            ".then(b=>console.log('[monitor→redis-live]',b.date,b.events))"
            ".catch(e=>{console.error('[monitor→redis-live]',e.message);process.exit(0)})",
        ),
        (
            "new",
            "require('./src/services/tennisNewFromMonitor')"
            ".refreshNewBundleFromMonitor()"
            ".then(b=>console.log('[monitor→redis-new]',b.date,b.events))"
            ".catch(e=>{console.error('[monitor→redis-new]',e.message);process.exit(0)})",
        ),
    ]
    scripts = all_scripts if scope == "full" else [all_scripts[1]]
    for label, node in scripts:
        try:
            r = subprocess.run(
                ["docker", "exec", YUCE_SERVER_CONTAINER, "node", "-e", node],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if r.stdout.strip():
                print(r.stdout.strip())
            if r.stderr.strip():
                print(r.stderr.strip())
        except Exception as exc:
            print(f"[monitor→redis-{label}] skip: {exc}")


def _run_collect(trigger: str = "auto") -> None:
    global _running, _last_run
    with _lock:
        if _running:
            return
        _running = True
        _last_run = {"status": "running", "trigger": trigger, "started_at": _now(), "error": None}
    _append_log(f"=== collect {trigger} {_now()} ===")
    try:
        snapshot = run_live_sync(include_scheduled=True)
        path = _write_bundle(snapshot)
        _append_log(f"bundle {path.name} events={snapshot.get('total_events')} live={snapshot.get('live_count')}")
        if snapshot.get("error") and not (snapshot.get("total_events") or 0):
            raise RuntimeError(snapshot["error"])
        with _lock:
            _last_run = {
                "status": "success",
                "trigger": trigger,
                "started_at": _last_run.get("started_at"),
                "finished_at": _now(),
                "exit_code": 0,
                "error": None,
                "db": snapshot.get("db"),
            }
        _refresh_server_redis()
    except Exception as exc:
        _append_log(f"collect failed: {exc}")
        with _lock:
            _last_run = {
                "status": "failed",
                "trigger": trigger,
                "finished_at": _now(),
                "exit_code": -1,
                "error": _friendly_error(exc),
            }
    finally:
        with _lock:
            _running = False


def _run_live_sync(trigger: str = "auto") -> None:
    global _live_running, _last_live
    with _top100_lock:
        if _top100_running:
            print("[live] skip: top100 collect running")
            return
    with _live_lock:
        if _live_running:
            return
        _live_running = True
        _last_live = {
            "status": "running",
            "trigger": trigger,
            "started_at": _now(),
            "finished_at": None,
            "live_count": 0,
            "total_events": 0,
            "updated": 0,
            "ended": 0,
            "error": None,
            "fetched_at": None,
            "events": [],
        }
    try:
        result = run_live_sync(include_scheduled=False)
        live_matches = result.get("live_matches") or []
        if result.get("top100"):
            apply_top100_snapshot(result)
        db_result = result.get("db") or {}
        with _live_lock:
            _last_live = {
                "status": "success",
                "trigger": trigger,
                "started_at": _last_live.get("started_at"),
                "finished_at": _now(),
                "live_count": len(live_matches),
                "total_events": result.get("total_events") or 0,
                "updated": db_result.get("updated") or 0,
                "ended": db_result.get("ended") or 0,
                "error": _friendly_error(result["error"]) if result.get("error") else None,
                "fetched_at": result.get("fetched_at"),
                "events": live_matches,
                "date": result.get("date"),
                "db": db_result,
            }
        if not (_latest_bundle_full() or {}).get("ok"):
            _write_bundle(result)
        _refresh_server_redis(scope="live")
    except Exception as exc:
        with _live_lock:
            _last_live.update({"status": "failed", "finished_at": _now(), "error": _friendly_error(exc)})
        print(f"[live] {trigger} failed: {exc}")
    finally:
        with _live_lock:
            _live_running = False
        gc.collect()


def _live_loop() -> None:
    time.sleep(5)
    while True:
        try:
            _run_live_sync("auto")
        except Exception as exc:
            print(f"[live-loop] {exc}")
        time.sleep(max(30, LIVE_INTERVAL_SEC))


def _start_live_loop() -> None:
    threading.Thread(target=_live_loop, daemon=True, name="live-poll").start()


def _live_payload() -> dict[str, Any]:
    with _live_lock:
        return {
            "ok": True,
            "running": _live_running,
            "interval_sec": LIVE_INTERVAL_SEC,
            "last": dict(_last_live),
        }


def _build_top20() -> dict[str, Any]:
    cached = get_cached_top20_payload()
    if cached:
        return build_top20_response()
    bundle = _latest_bundle_full()
    if bundle.get("ok") and bundle.get("top20"):
        restore_top20_board(bundle["top20"])
        events: list[dict] = []
        for t in (bundle.get("scheduled") or {}).get("tournaments") or []:
            events.extend(t.get("events") or [])
        return build_top20_response(events)
    return {"ok": False, "error": "暂无 Top20 数据，请先触发采集", "loading": False, "atp": [], "wta": []}


def _top100_summary_from_board(top100: dict[str, Any], snap: dict[str, Any] | None = None) -> dict[str, Any]:
    atp = top100.get("atp") or []
    wta = top100.get("wta") or []
    atp_matches = sum(len(p.get("matches") or []) for p in atp)
    wta_matches = sum(len(p.get("matches") or []) for p in wta)
    base = (top100.get("summary") or {}) if isinstance(top100.get("summary"), dict) else {}
    out = {
        **base,
        "atp_players": len(atp),
        "wta_players": len(wta),
        "atp_matches": atp_matches,
        "wta_matches": wta_matches,
        "total_matches": atp_matches + wta_matches,
        "live_matches": snap.get("live_count") if snap else base.get("live_matches") or 0,
    }
    return out


def _top100_api_from_snap(snap: dict[str, Any]) -> dict[str, Any]:
    top100 = snap.get("top100") or {}
    return {
        "ok": True,
        "date": snap.get("date"),
        "fetched_at": snap.get("fetched_at"),
        "loading": False,
        "atp": top100.get("atp") or [],
        "wta": top100.get("wta") or [],
        "summary": _top100_summary_from_board(top100, snap),
        "elapsed_sec": snap.get("elapsed_sec"),
        "requests": snap.get("requests") or {},
        "error": snap.get("error"),
    }


def apply_top100_snapshot(snap: dict[str, Any]) -> None:
    """采集或 live 刷新后，同步 Top100 内存缓存（供 GET /top100）。"""
    top100 = snap.get("top100")
    if not top100 or not (top100.get("atp") or top100.get("wta")):
        return
    restore_top100_board(top100)
    payload = _top100_api_from_snap(snap)
    payload["atp"] = copy.deepcopy(payload.get("atp") or [])
    payload["wta"] = copy.deepcopy(payload.get("wta") or [])
    _top100_cache.update(payload)


def _run_top100_collect(trigger: str = "auto") -> None:
    global _top100_running, _last_top100
    with _live_lock:
        if _live_running:
            print("[top100] skip: live sync running")
            return
    with _top100_lock:
        if _top100_running:
            return
        _top100_running = True
        _top100_cache.update({"loading": True, "error": None})
        _last_top100 = {"status": "running", "trigger": trigger, "started_at": _now(), "error": None}
    _append_log(f"=== top100 collect {trigger} {_now()} ===")
    try:
        snap = collect_top100_snapshot(
            include_scheduled=True,
            force_schedule=trigger in ("manual-http", "http-refresh"),
        )
        apply_top100_snapshot(snap)
        with _top100_lock:
            _last_top100 = {
                "status": "success",
                "trigger": trigger,
                "started_at": _last_top100.get("started_at"),
                "finished_at": _now(),
                "exit_code": 0,
                "error": snap.get("error"),
                "total_events": snap.get("total_events"),
                "live_count": snap.get("live_count"),
                "elapsed_sec": snap.get("elapsed_sec"),
                "requests": snap.get("requests") or {},
            }
        _append_log(
            f"top100 ok events={snap.get('total_events')} live={snap.get('live_count')} "
            f"elapsed={snap.get('elapsed_sec')}s requests={((snap.get('requests') or {}).get('total'))}"
        )
        db_result = _write_mysql(snap, live_only=False)
        _append_log(f"mysql {db_result}")
        _refresh_server_redis()
    except Exception as exc:
        err = _friendly_error(exc)
        _append_log(f"top100 collect failed: {err}")
        _top100_cache.update({"loading": False, "ok": False, "error": err})
        with _top100_lock:
            _last_top100 = {
                "status": "failed",
                "trigger": trigger,
                "started_at": _last_top100.get("started_at"),
                "finished_at": _now(),
                "exit_code": -1,
                "error": err,
            }
    finally:
        with _top100_lock:
            _top100_running = False
        gc.collect()


def _top100_status_payload() -> dict[str, Any]:
    with _top100_lock:
        return {
            "running": _top100_running,
            "last": dict(_last_top100),
            "cached_at": _top100_cache.get("fetched_at"),
            "summary": _top100_cache.get("summary") or {},
        }


def _top100_api_payload(*, refresh: bool = False) -> dict[str, Any]:
    if refresh:
        with _top100_lock:
            running = _top100_running
        if not running:
            threading.Thread(target=_run_top100_collect, args=("http-refresh",), daemon=True).start()
            _top100_cache.update({"loading": True, "error": None})
    if _top100_cache.get("loading") or _top100_cache.get("atp") or _top100_cache.get("wta"):
        return dict(_top100_cache)
    resp = build_top100_response()
    if resp.get("ok"):
        _top100_cache.update(resp)
        return dict(_top100_cache)
    return resp


def _build_top100_bundle() -> dict[str, Any]:
    snap = collect_top100_snapshot(include_scheduled=True)
    events = snap.get("events") or []
    scheduled = _group_scheduled(events)
    live = [e for e in events if str(e.get("statusType") or e.get("status") or "").lower() in {
        "inprogress", "live", "interrupted"
    } or "live" in str(e.get("status") or "").lower()]
    restore_top100_board(snap.get("top100"))
    return {
        "ok": True,
        "sport": "tennis",
        "date": snap.get("date"),
        "fetched_at": snap.get("fetched_at"),
        "filter": "top100",
        "top_rank_max": 100,
        "top100": snap.get("top100") or {},
        "scheduled": scheduled,
        "live": {
            "matches": live,
            "tournaments": _group_scheduled(live).get("tournaments") or [],
            "tournamentCount": len(_group_scheduled(live).get("tournaments") or []),
            "eventCount": len(live),
        },
        "rankingsByPlayer": snap.get("rankingsByPlayer") or {},
        "oddsByEvent": snap.get("oddsByEvent") or {},
        "birthYearByPlayer": snap.get("birthYearByPlayer") or {},
        "events": len(events),
        "live_count": len(live),
        "elapsed_sec": snap.get("elapsed_sec"),
        "requests": snap.get("requests") or {},
        "error": snap.get("error"),
    }


def _status_payload() -> dict[str, Any]:
    with _lock:
        last = dict(_last_run)
        running = _running
    return {
        "ok": True,
        "running": running,
        "last_run": last,
        "latest_bundle": _latest_bundle_meta(),
        "cron": _cron_lines(),
        "schedule": _schedule_payload(),
        "live_poll": _live_payload(),
        "top100_collect": _top100_status_payload(),
        "proxy": proxy_status_public(),
        "endpoints": {
            "status": "GET /status",
            "health": "GET /health",
            "collect": "POST /collect",
            "logs": "GET /logs?lines=100",
            "top20": "GET /top20",
            "top100": "GET /top100?refresh=1",
            "top100_collect": "POST /top100/collect",
            "bundle_top100": "GET /bundle/top100",
            "bundle": "GET /bundle",
            "live": "GET /live",
            "live_collect": "POST /live/collect",
            "events_today": "GET /events/today",
            "schedule": "GET /schedule",
        },
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[http] {self.address_string()} {fmt % args}")

    def _json(self, code: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True})
            return
        if not _auth_ok(self):
            self._json(401, {"error": "unauthorized"})
            return
        if path == "/live":
            self._json(200, _live_payload())
            return
        if path == "/bundle/top100" or path == "/bundle":
            if path == "/bundle/top100":
                try:
                    self._json(200, _build_top100_bundle())
                except Exception as exc:
                    self._json(500, {"ok": False, "error": _friendly_error(exc)})
                return
            self._json(200, _latest_bundle_full())
            return
        if path == "/events/today":
            snap = run_live_sync(include_scheduled=True)
            self._json(
                200,
                {
                    "ok": True,
                    "date": snap.get("date"),
                    "fetched_at": snap.get("fetched_at"),
                    "total_events": snap.get("total_events") or len(snap.get("events") or []),
                    "events": snap.get("events") or [],
                },
            )
            return
        if path == "/schedule":
            self._json(200, _schedule_payload())
            return
        if path == "/top20":
            qs = parse_qs(urlparse(self.path).query)
            refresh = (qs.get("refresh") or ["0"])[0] == "1"
            if refresh or not _top20_cache.get("atp"):
                _top20_cache.update(_build_top20())
            self._json(200, _top20_cache)
            return
        if path == "/top100":
            qs = parse_qs(urlparse(self.path).query)
            refresh = (qs.get("refresh") or ["0"])[0] == "1"
            try:
                self._json(200, _top100_api_payload(refresh=refresh))
            except Exception as exc:
                self._json(500, {"ok": False, "error": _friendly_error(exc)})
            return
        if path == "/logs":
            qs = parse_qs(urlparse(self.path).query)
            lines = int((qs.get("lines") or ["120"])[0] or 120)
            self._json(200, _read_logs(lines))
            return
        if path in ("/", "/status"):
            self._json(200, _status_payload())
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not _auth_ok(self):
            self._json(401, {"error": "unauthorized"})
            return
        if path == "/live/collect":
            with _live_lock:
                if _live_running:
                    self._json(409, {"error": "live collect already running", "last": dict(_last_live)})
                    return
            threading.Thread(target=_run_live_sync, args=("manual-http",), daemon=True).start()
            time.sleep(0.2)
            self._json(202, {"ok": True, "message": "live collect started", "last": dict(_last_live)})
            return
        if path == "/top100/collect":
            with _top100_lock:
                if _top100_running:
                    self._json(409, {"error": "top100 collect already running", "last": dict(_last_top100)})
                    return
            threading.Thread(target=_run_top100_collect, args=("manual-http",), daemon=True).start()
            time.sleep(0.2)
            self._json(202, {"ok": True, "message": "top100 collect started", "last": dict(_last_top100)})
            return
        if path == "/schedule":
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            body = json.loads(raw or "{}")
            try:
                self._json(200, _set_collect_schedule(int(body.get("interval_hours") or 0)))
            except Exception as exc:
                self._json(400, {"ok": False, "error": str(exc)})
            return
        if path != "/collect":
            self._json(404, {"error": "not found"})
            return
        with _top100_lock:
            if _top100_running:
                self._json(409, {"error": "top100 collect already running", "last": dict(_last_top100)})
                return
        threading.Thread(target=_run_top100_collect, args=("manual-http",), daemon=True).start()
        time.sleep(0.2)
        self._json(202, {"ok": True, "message": "top100 collect started", "last": dict(_last_top100)})


def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    _start_live_loop()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"sofascore monitor listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
