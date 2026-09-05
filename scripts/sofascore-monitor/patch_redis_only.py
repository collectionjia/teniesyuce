#!/usr/bin/env python3
"""Patch monitor: GET /bundle, collect --no-db, live skip MySQL."""
from __future__ import annotations

from pathlib import Path

APP = Path("/home/ubuntu/sofascore-tennis-scraper")
MONITOR = APP / "monitor_server.py"
LIVE = APP / "live_collector.py"
RUN = APP / "deploy" / "run_collect.sh"

# --- live_collector: skip MySQL ---
live_text = LIVE.read_text(encoding="utf-8")
old_run = '''def run_live_sync(*, include_scheduled: bool = True) -> dict[str, Any]:
    snapshot = collect_live_snapshot(include_scheduled=include_scheduled)
    conn = connect()
    try:
        db_result = update_live_events(conn, snapshot.get("events") or [])
        snapshot["db"] = db_result
    finally:
        conn.close()
    live_only = [
        e for e in snapshot.get("events") or []
        if not _is_ended({"status": {"description": e.get("status"), "type": e.get("statusType")}})
        and _is_live({"status": {"description": e.get("status"), "type": e.get("statusType")}})
    ]
    snapshot["live_matches"] = live_only
    return snapshot'''

new_run = '''def run_live_sync(*, include_scheduled: bool = True, write_mysql: bool = False) -> dict[str, Any]:
    """采集 live；默认不写 MySQL（由 Node 写入 Redis 供前端读取）。"""
    snapshot = collect_live_snapshot(include_scheduled=include_scheduled)
    if write_mysql:
        conn = connect()
        try:
            db_result = update_live_events(conn, snapshot.get("events") or [])
            snapshot["db"] = db_result
        finally:
            conn.close()
    else:
        snapshot["db"] = {"updated": 0, "ended": 0, "skipped": True}
    live_only = [
        e for e in snapshot.get("events") or []
        if not _is_ended({"status": {"description": e.get("status"), "type": e.get("statusType")}})
        and _is_live({"status": {"description": e.get("status"), "type": e.get("statusType")}})
    ]
    snapshot["live_matches"] = live_only
    return snapshot'''

if old_run not in live_text:
    if "skipped" in live_text and "write_mysql" in live_text:
        print("live_collector already patched")
    else:
        raise SystemExit("live_collector run_live_sync block not found")
else:
    LIVE.write_text(live_text.replace(old_run, new_run), encoding="utf-8")
    print("patched live_collector.py")

# --- run_collect.sh: --no-db ---
run_text = RUN.read_text(encoding="utf-8")
if "collect_daily.py --no-db" not in run_text:
    if '"$APP_DIR/venv/bin/python" collect_daily.py' not in run_text:
        raise SystemExit("run_collect.sh collect line not found")
    RUN.write_text(
        run_text.replace(
            '"$APP_DIR/venv/bin/python" collect_daily.py',
            '"$APP_DIR/venv/bin/python" collect_daily.py --no-db',
        ),
        encoding="utf-8",
    )
    print("patched run_collect.sh --no-db")
else:
    print("run_collect.sh already --no-db")

# --- run_collect.sh: after collect, refresh Redis in server container ---
run_text = RUN.read_text(encoding="utf-8")
REDIS_REFRESH = '''
echo "=== refresh redis $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
docker exec bbbbb-server-1 node -e "require('./src/services/tennisFromMonitor').refreshRedisFromMonitor({includeLive:true}).then(b=>console.log('[collect→redis]',b.date,b.events,'live',b.live?.eventCount||0)).catch(e=>{console.error(e.message);process.exit(0)})" 2>/dev/null || echo "redis refresh skipped (server not running)"
'''
if "refreshRedisFromMonitor" not in run_text:
    if 'echo "=== end' in run_text:
        run_text = run_text.replace(
            'echo "=== end',
            REDIS_REFRESH + '\necho "=== end',
            1,
        )
        RUN.write_text(run_text, encoding="utf-8")
        print("patched run_collect.sh redis refresh hook")
    else:
        print("WARN: could not add redis refresh hook")
else:
    print("run_collect.sh redis hook exists")

# --- monitor_server: /bundle + collect --no-db fallback ---
text = MONITOR.read_text(encoding="utf-8")

BUNDLE_HELPER = '''
def _latest_bundle_full() -> dict[str, Any]:
    """返回最新 daily_bundle 全量 JSON（供 Node 写入 Redis）。"""
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
'''

if "_latest_bundle_full" not in text:
    anchor = "def _latest_bundle_meta() -> dict[str, Any]:"
    if anchor not in text:
        raise SystemExit("cannot find _latest_bundle_meta")
    text = text.replace(anchor, BUNDLE_HELPER + "\n" + anchor, 1)
    print("added _latest_bundle_full")
else:
    print("_latest_bundle_full exists")

# GET /bundle route
if 'path == "/bundle"' not in text:
    live_route = '''        if path == "/live":
            if not _auth_ok(self):
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, _live_payload())
            return'''
    bundle_route = '''        if path == "/bundle":
            if not _auth_ok(self):
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, _latest_bundle_full())
            return
        if path == "/live":
            if not _auth_ok(self):
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, _live_payload())
            return'''
    if live_route not in text:
        raise SystemExit("cannot find /live GET handler")
    text = text.replace(live_route, bundle_route, 1)
    print("added GET /bundle")
else:
    print("GET /bundle exists")

# endpoints list
if '"bundle"' not in text:
    text = text.replace(
        '"live": "GET /live",',
        '"bundle": "GET /bundle",\n            "live": "GET /live",',
        1,
    )
    print("registered bundle endpoint")

# collect fallback without run script: add --no-db
old_py = 'proc = subprocess.run([str(PYTHON), str(COLLECT_SCRIPT)], cwd=str(APP_DIR), capture_output=True, text=True)'
new_py = 'proc = subprocess.run([str(PYTHON), str(COLLECT_SCRIPT), "--no-db"], cwd=str(APP_DIR), capture_output=True, text=True)'
if old_py in text:
    text = text.replace(old_py, new_py, 1)
    print("collect fallback --no-db")
elif "--no-db" in text:
    print("collect fallback already --no-db")
else:
    print("WARN: collect fallback line not updated")

MONITOR.write_text(text, encoding="utf-8")
print("wrote monitor_server.py")

# syntax check
import py_compile
py_compile.compile(str(MONITOR), doraise=True)
py_compile.compile(str(LIVE), doraise=True)
print("syntax ok")
