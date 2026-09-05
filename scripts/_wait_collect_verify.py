#!/usr/bin/env python3
import json
import time
import urllib.request
from datetime import datetime, timezone, timedelta

BJ = timezone(timedelta(hours=8))

def status():
    req = urllib.request.Request(
        "http://127.0.0.1:9004/status",
        headers={"Authorization": "Bearer sofascore-monitor-2026"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)

for i in range(40):
    s = status()
    lr = s.get("last_run") or {}
    print(i, lr.get("status"), lr.get("finished_at"), lr.get("error"))
    if lr.get("status") in ("ok", "error", "failed") and lr.get("finished_at"):
        break
    time.sleep(5)

# refresh redis
import subprocess
subprocess.check_call([
    "sudo", "docker", "exec", "bbbbb-server-1", "node", "-e",
    "require('./src/services/tennisFromMonitor').refreshRedisFromMonitor({includeLive:true}).then(b=>console.log('redis',b.date,b.events)).catch(e=>{console.error(e);process.exit(1)})"
])

raw = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-redis-1", "redis-cli", "GET", "tennis:bundle:full"],
    text=True,
)
b = json.loads(raw)
events = []
for t in (b.get("scheduled") or {}).get("tournaments") or []:
    for e in t.get("events") or []:
        events.append(e)
print("events", len(events), "date", b.get("date"))
for e in events[:8]:
    ts = e.get("startTimestamp")
    home = (e.get("homePlayer") or {}).get("name") or e.get("home")
    away = (e.get("awayPlayer") or {}).get("name") or e.get("away")
    bj = datetime.fromtimestamp(ts, BJ).strftime("%m-%d %H:%M") if ts else "?"
    print(f"  BJ {bj} | {home} vs {away}")
