#!/usr/bin/env python3
"""Compare Sofascore raw startTimestamp vs bundle values."""
import json
import subprocess
import urllib.request
from datetime import datetime, timezone, timedelta

TOKEN = "sofascore-monitor-2026"

def get(path):
    req = urllib.request.Request(
        f"http://127.0.0.1:9004{path}",
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)

raw = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-redis-1", "redis-cli", "GET", "tennis:bundle:full"],
    text=True,
)
b = json.loads(raw)
print("bundle date", b.get("date"), "fetched", b.get("fetched_at"))

# Find collect source on disk
import os
out = "/home/ubuntu/sofascore-tennis-scraper/output"
files = sorted([f for f in os.listdir(out) if f.startswith("daily_bundle") and f.endswith(".json")]) if os.path.isdir(out) else []
print("bundle files", files[-5:])
if files:
    p = os.path.join(out, files[-1])
    with open(p, encoding="utf-8") as f:
        disk = json.load(f)
    print("disk date", disk.get("date"), "file", files[-1])
    # sample events
    events = []
    for t in (disk.get("scheduled") or {}).get("tournaments") or []:
        for e in t.get("events") or []:
            events.append(e)
    print("disk events", len(events))
    china = timezone(timedelta(hours=8))
    et = timezone(timedelta(hours=-4))
    for e in events[:10]:
        ts = e.get("startTimestamp")
        home = (e.get("homePlayer") or {}).get("name") or e.get("home")
        away = (e.get("awayPlayer") or {}).get("name") or e.get("away")
        if not ts:
            continue
        print("---")
        print(home, "vs", away, "id", e.get("id"))
        print("  raw ts", ts)
        print("  UTC ", datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M"))
        print("  ET  ", datetime.fromtimestamp(ts, tz=et).strftime("%Y-%m-%d %H:%M"))
        print("  CST ", datetime.fromtimestamp(ts, tz=china).strftime("%Y-%m-%d %H:%M"))
        # dump related keys
        keys = [k for k in e.keys() if "time" in k.lower() or "start" in k.lower() or "date" in k.lower()]
        print("  time-keys", {k: e.get(k) for k in keys})

# check sofascore client parsing
for path in [
    "/home/ubuntu/sofascore-tennis-scraper/sofascore_client.py",
    "/home/ubuntu/sofascore-tennis-scraper/collect_daily.py",
    "/home/ubuntu/sofascore-tennis-scraper/models.py",
]:
    if os.path.isfile(path):
        print("FILE", path)
        with open(path, encoding="utf-8", errors="ignore") as f:
            for i, line in enumerate(f, 1):
                if "startTimestamp" in line or "start_timestamp" in line or "startDate" in line:
                    print(f"  {i}: {line.rstrip()[:160]}")
