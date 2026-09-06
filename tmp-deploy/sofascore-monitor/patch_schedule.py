"""Patch monitor_server.py to add collect schedule API (2/4/6/12 hours)."""
from __future__ import annotations

from pathlib import Path

P = Path("/home/ubuntu/sofascore-tennis-scraper/monitor_server.py")
text = P.read_text(encoding="utf-8")

SCHEDULE_BLOCK = '''ALLOWED_COLLECT_INTERVALS = (2, 4, 6, 12)
SCHEDULE_FILE = APP_DIR / "config" / "schedule.json"
COLLECT_CRON_CMD = str(RUN_SCRIPT) if RUN_SCRIPT.exists() else f"{PYTHON} {COLLECT_SCRIPT}"


def _read_schedule_config() -> dict[str, Any]:
    if SCHEDULE_FILE.exists():
        try:
            data = json.loads(SCHEDULE_FILE.read_text(encoding="utf-8"))
            hours = int(data.get("interval_hours") or 0)
            if hours in ALLOWED_COLLECT_INTERVALS:
                return {"interval_hours": hours}
        except Exception:
            pass
    for line in _cron_lines():
        if "run_collect" not in line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        expr = parts[0]
        if expr.startswith("*/"):
            try:
                hours = int(expr[2:])
                if hours in ALLOWED_COLLECT_INTERVALS:
                    return {"interval_hours": hours}
            except ValueError:
                pass
        if expr.isdigit() and parts[1].startswith("*/"):
            try:
                hours = int(parts[1][2:])
                if hours in ALLOWED_COLLECT_INTERVALS:
                    return {"interval_hours": hours}
            except ValueError:
                pass
    return {"interval_hours": 6}


def _write_schedule_config(interval_hours: int) -> None:
    SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEDULE_FILE.write_text(
        json.dumps({"interval_hours": interval_hours}, ensure_ascii=False, indent=2) + "\\n",
        encoding="utf-8",
    )


def _cron_expr_for_interval(hours: int) -> str:
    return f"0 */{hours} * * *"


def _apply_collect_schedule(interval_hours: int) -> list[str]:
    marker = "# sofascore-tennis-scraper"
    cron_line = f"{_cron_expr_for_interval(interval_hours)} {COLLECT_CRON_CMD}"
    try:
        raw = subprocess.check_output(["crontab", "-l"], text=True, stderr=subprocess.DEVNULL)
        lines = raw.splitlines()
    except Exception:
        lines = []
    kept: list[str] = []
    skip = False
    for line in lines:
        if marker in line:
            skip = True
            continue
        if skip:
            if line.startswith("CRON_TZ") or "run_collect" in line:
                continue
            if not line.strip():
                skip = False
                continue
            skip = False
        if "run_collect" in line:
            continue
        kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    block = [marker, "CRON_TZ=Asia/Shanghai", cron_line]
    new_lines = kept + ([""] if kept else []) + block
    payload = "\\n".join(new_lines).rstrip("\\n") + "\\n"
    subprocess.run(["crontab", "-"], input=payload, text=True, check=True)
    return block


def _schedule_payload() -> dict[str, Any]:
    cfg = _read_schedule_config()
    hours = int(cfg["interval_hours"])
    return {
        "ok": True,
        "interval_hours": hours,
        "allowed_intervals": list(ALLOWED_COLLECT_INTERVALS),
        "cron_line": f"{_cron_expr_for_interval(hours)} {COLLECT_CRON_CMD}",
        "label": f"每 {hours} 小时",
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


'''

STATUS_OLD = '        "cron": _cron_lines(),'
STATUS_NEW = '''        "cron": _cron_lines(),
        "schedule": _schedule_payload(),'''

GET_PATCH = '''        if path == "/schedule":
            if not _auth_ok(self):
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, _schedule_payload())
            return
        if path in ("/", "/status"):'''

POST_PATCH_OLD = '''        if path == "/live/collect":
            with _live_lock:
                if _live_running:
                    self._json(409, {"error": "live collect already running", "last": dict(_last_live)})
                    return
            t = threading.Thread(target=_run_live_sync, args=("manual-http",), daemon=True)
            t.start()
            time.sleep(0.2)
            self._json(202, {"ok": True, "message": "live collect started", "last": dict(_last_live)})
            return
        if path != "/collect":'''

POST_PATCH_NEW = '''        if path == "/live/collect":
            with _live_lock:
                if _live_running:
                    self._json(409, {"error": "live collect already running", "last": dict(_last_live)})
                    return
            t = threading.Thread(target=_run_live_sync, args=("manual-http",), daemon=True)
            t.start()
            time.sleep(0.2)
            self._json(202, {"ok": True, "message": "live collect started", "last": dict(_last_live)})
            return
        if path == "/schedule":
            try:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length).decode("utf-8") if length else "{}"
                body = json.loads(raw or "{}")
                hours = int(body.get("interval_hours") or 0)
                payload = _set_collect_schedule(hours)
                self._json(200, payload)
            except ValueError as exc:
                self._json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._json(500, {"ok": False, "error": str(exc)})
            return
        if path != "/collect":'''


def apply() -> None:
    text2 = text
    if "ALLOWED_COLLECT_INTERVALS" not in text2:
        anchor = "def _cron_lines() -> list[str]:"
        text2 = text2.replace(anchor, SCHEDULE_BLOCK + "\n" + anchor, 1)
    text2 = text2.replace(STATUS_OLD, STATUS_NEW, 1)
    if 'path == "/schedule"' not in text2:
        text2 = text2.replace(
            '        if path in ("/", "/status"):',
            GET_PATCH,
            1,
        )
    if 'path == "/schedule"' not in text2.split("def do_POST")[1]:
        text2 = text2.replace(POST_PATCH_OLD, POST_PATCH_NEW, 1)
    P.write_text(text2, encoding="utf-8")
    print("monitor_server.py schedule patch applied")


if __name__ == "__main__":
    apply()
