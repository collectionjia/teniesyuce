#!/usr/bin/env python3
import json
import urllib.request
from datetime import datetime, timezone, timedelta

# Fetch one Sofascore event and compare
eid = 16901503  # Nakashima vs Michelsen

# try sofascore via local scraper client helpers if available
urls = [
    f"https://www.sofascore.com/api/v1/event/{eid}",
    f"https://api.sofascore.com/api/v1/event/{eid}",
]

for url in urls:
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
        ev = data.get("event") or data
        ts = ev.get("startTimestamp")
        print("OK", url)
        print("  startTimestamp", ts)
        if ts:
            print("  UTC", datetime.fromtimestamp(ts, tz=timezone.utc))
            print("  ET ", datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=-4))))
            print("  CST", datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=8))))
        print("  status", ev.get("status"))
        print("  home", (ev.get("homeTeam") or {}).get("name"))
        print("  away", (ev.get("awayTeam") or {}).get("name"))
        print("  startTime", ev.get("startTime"), "startDate", ev.get("startDate"))
        break
    except Exception as e:
        print("FAIL", url, e)

# Also show how collect maps fields
import re
from pathlib import Path
p = Path("/home/ubuntu/sofascore-tennis-scraper/sofascore_client.py")
text = p.read_text(encoding="utf-8", errors="ignore")
# print function containing startTimestamp
for m in re.finditer(r".{0,80}startTimestamp.{0,80}", text):
    print("CTX:", m.group(0).replace("\n", " | "))

# collect_daily event shaping
p2 = Path("/home/ubuntu/sofascore-tennis-scraper/collect_daily.py")
if p2.exists():
    t2 = p2.read_text(encoding="utf-8", errors="ignore")
    for m in re.finditer(r".{0,100}startTimestamp.{0,100}", t2):
        print("COLLECT:", m.group(0).replace("\n", " | "))
    for m in re.finditer(r"def (normalize|to_event|build_event|event_from).{0,200}", t2):
        print("DEF:", m.group(0)[:200])
