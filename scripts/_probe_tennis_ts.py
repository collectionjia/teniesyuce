#!/usr/bin/env python3
import json
import subprocess
import time
from datetime import datetime, timezone

raw = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-redis-1", "redis-cli", "GET", "tennis:bundle:full"],
    text=True,
)
b = json.loads(raw)
now = int(time.time())
print("serverTime", b.get("serverTime"), "now", now, "date", b.get("date"), "tz_server", time.tzname)
events = []
for t in (b.get("scheduled") or {}).get("tournaments") or []:
    for e in t.get("events") or []:
        events.append(e)
print("scheduled", len(events))
for e in events[:15]:
    ts = e.get("startTimestamp")
    home = (e.get("homePlayer") or {}).get("name") or e.get("home")
    away = (e.get("awayPlayer") or {}).get("name") or e.get("away")
    if not ts:
        print("NO_TS", e.get("id"), home, "vs", away)
        continue
    utc = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    local = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M local")
    print(f"{ts} | {utc} | {local} | {e.get('status')} | {home} vs {away}")
