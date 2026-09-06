"""Patch monitor_server.py to add live polling every 60s."""
from __future__ import annotations

from pathlib import Path

P = Path("/home/ubuntu/sofascore-tennis-scraper/monitor_server.py")
text = P.read_text(encoding="utf-8")

IMPORT_BLOCK = "from top20_board import build_top20_board"
IMPORT_NEW = """from top20_board import build_top20_board
from live_collector import run_live_sync"""

STATE_BLOCK = "TOP20_TTL_SEC = 10 * 60"
STATE_NEW = """TOP20_TTL_SEC = 10 * 60
LIVE_INTERVAL_SEC = int(os.environ.get("LIVE_POLL_INTERVAL_SEC", "60"))
_live_lock = threading.Lock()
_live_running = False
_last_live: dict[str, Any] = {
    "status": "idle",
    "trigger": None,
    "started_at": None,
    "finished_at": None,
    "live_count": 0,
    "total_events": 0,
    "updated": 0,
    "ended": 0,
    "error": None,
    "fetched_at": None,
    "events": [],
}"""

HELPERS = '''

def _run_live_sync(trigger: str = "auto") -> None:
    global _live_running, _last_live
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
        result = run_live_sync(include_scheduled=True)
        live_matches = result.get("live_matches") or []
        db = result.get("db") or {}
        with _live_lock:
            _last_live = {
                "status": "success",
                "trigger": trigger,
                "started_at": _last_live.get("started_at"),
                "finished_at": _now(),
                "live_count": len(live_matches),
                "total_events": result.get("total_events") or 0,
                "updated": db.get("updated") or 0,
                "ended": db.get("ended") or 0,
                "error": result.get("error"),
                "fetched_at": result.get("fetched_at"),
                "events": live_matches,
            }
        print(
            f"[live] {trigger} ok: live={len(live_matches)} "
            f"updated={db.get('updated')} ended={db.get('ended')}"
        )
    except Exception as exc:
        with _live_lock:
            _last_live.update({
                "status": "failed",
                "finished_at": _now(),
                "error": str(exc),
            })
        print(f"[live] {trigger} failed: {exc}")
    finally:
        with _live_lock:
            _live_running = False


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
'''

STATUS_PATCH_OLD = '''        "endpoints": {
            "status": "GET /",
            "health": "GET /health",
            "collect": "POST /collect",
            "logs": "GET /logs?lines=100",
            "top20": "GET /top20",
        },
    }'''

STATUS_PATCH_NEW = '''        "live_poll": _live_payload(),
        "endpoints": {
            "status": "GET /",
            "health": "GET /health",
            "collect": "POST /collect",
            "logs": "GET /logs?lines=100",
            "top20": "GET /top20",
            "live": "GET /live",
            "live_collect": "POST /live/collect",
        },
    }'''

GET_PATCH = '''        if path == "/live":
            if not _auth_ok(self):
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, _live_payload())
            return
        if path in ("/", "/status"):'''

POST_PATCH_OLD = '''    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/collect":
            self._json(404, {"error": "not found"})
            return
        if not _auth_ok(self):
            self._json(401, {"error": "unauthorized"})
            return
        with _lock:
            if _running:
                self._json(409, {"error": "collect already running", "last_run": dict(_last_run)})
                return
        t = threading.Thread(target=_run_collect, args=("manual-http",), daemon=True)
        t.start()
        time.sleep(0.2)
        self._json(202, {"ok": True, "message": "collect started", "last_run": dict(_last_run)})'''

POST_PATCH_NEW = '''    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not _auth_ok(self):
            self._json(401, {"error": "unauthorized"})
            return
        if path == "/live/collect":
            with _live_lock:
                if _live_running:
                    self._json(409, {"error": "live collect already running", "last": dict(_last_live)})
                    return
            t = threading.Thread(target=_run_live_sync, args=("manual-http",), daemon=True)
            t.start()
            time.sleep(0.2)
            self._json(202, {"ok": True, "message": "live collect started", "last": dict(_last_live)})
            return
        if path != "/collect":
            self._json(404, {"error": "not found"})
            return
        with _lock:
            if _running:
                self._json(409, {"error": "collect already running", "last_run": dict(_last_run)})
                return
        t = threading.Thread(target=_run_collect, args=("manual-http",), daemon=True)
        t.start()
        time.sleep(0.2)
        self._json(202, {"ok": True, "message": "collect started", "last_run": dict(_last_run)})'''

MAIN_PATCH_OLD = '''def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)'''

MAIN_PATCH_NEW = '''def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _start_live_loop()
    server = ThreadingHTTPServer((HOST, PORT), Handler)'''


def apply() -> None:
    if "from live_collector import run_live_sync" not in text:
        text2 = text.replace(IMPORT_BLOCK, IMPORT_NEW, 1)
    else:
        text2 = text
    if "LIVE_INTERVAL_SEC" not in text2:
        text2 = text2.replace(STATE_BLOCK, STATE_NEW, 1)
    if "def _run_live_sync" not in text2:
        anchor = "def _cron_lines() -> list[str]:"
        text2 = text2.replace(anchor, HELPERS + "\n\n" + anchor, 1)
    text2 = text2.replace(STATUS_PATCH_OLD, STATUS_PATCH_NEW, 1)
    if 'path == "/live"' not in text2:
        text2 = text2.replace(
            '        if path in ("/", "/status"):',
            GET_PATCH,
            1,
        )
    if 'path == "/live/collect"' not in text2:
        text2 = text2.replace(POST_PATCH_OLD, POST_PATCH_NEW, 1)
    if "_start_live_loop()" not in text2:
        text2 = text2.replace(MAIN_PATCH_OLD, MAIN_PATCH_NEW, 1)
    P.write_text(text2, encoding="utf-8")
    print("monitor_server.py patched")


if __name__ == "__main__":
    apply()
