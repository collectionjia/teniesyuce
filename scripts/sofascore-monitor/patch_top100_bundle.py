"""Patch Sofascore monitor: GET /events/today 返回当日全量 slim 赛程（供 Top100 区间网球）"""
from __future__ import annotations

from pathlib import Path

P = Path("/home/ubuntu/sofascore-tennis-scraper/monitor_server.py")
text = P.read_text(encoding="utf-8")

EVENTS_HELPER = '''

def _events_today_payload() -> dict[str, Any]:
    from live_collector import collect_live_snapshot
    snap = collect_live_snapshot(include_scheduled=True)
    return {
        "ok": True,
        "date": snap.get("date"),
        "fetched_at": snap.get("fetched_at"),
        "total_events": snap.get("total_events") or len(snap.get("events") or []),
        "events": snap.get("events") or [],
    }
'''

if "_events_today_payload" not in text:
    anchor = "def _latest_bundle_full()"
    if anchor not in text:
        raise SystemExit("cannot find _latest_bundle_full")
    text = text.replace(anchor, EVENTS_HELPER + "\n\n" + anchor, 1)
    print("added _events_today_payload")
else:
    print("_events_today_payload exists")

GET_ROUTE = '''        if path == "/events/today":
            if not _auth_ok(self):
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, _events_today_payload())
            return
        if path == "/bundle":'''

if 'path == "/events/today"' not in text:
    if 'if path == "/bundle":' not in text:
        raise SystemExit("cannot find /bundle route")
    text = text.replace('        if path == "/bundle":', GET_ROUTE, 1)
    print("added GET /events/today")
else:
    print("GET /events/today exists")

if '"events_today"' not in text and '"bundle"' in text:
    text = text.replace(
        '"bundle": "GET /bundle",',
        '"bundle": "GET /bundle",\n            "events_today": "GET /events/today",',
        1,
    )
    print("registered events_today endpoint")

P.write_text(text, encoding="utf-8")
print("patch_top100_bundle done")
