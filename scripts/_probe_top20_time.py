#!/usr/bin/env python3
import json
import urllib.request
from datetime import datetime, timezone, timedelta

BJ = timezone(timedelta(hours=8))
ET = timezone(timedelta(hours=-4))

req = urllib.request.Request(
    "http://127.0.0.1:9004/top20",
    headers={"Authorization": "Bearer sofascore-monitor-2026", "Accept": "application/json"},
)
with urllib.request.urlopen(req, timeout=30) as resp:
    d = json.load(resp)

print("keys", list(d.keys()) if isinstance(d, dict) else type(d))

def walk(obj, path=""):
    if isinstance(obj, dict):
        if "startTime" in obj or "startTimestamp" in obj:
            print(path, {k: obj.get(k) for k in ("startTime", "startTimestamp", "home", "away", "player", "name", "opponent") if k in obj or True})
            st = obj.get("startTime")
            ts = obj.get("startTimestamp")
            print("  startTime=", st, "ts=", ts)
            if ts:
                print("  UTC", datetime.fromtimestamp(int(ts), timezone.utc))
                print("  BJ ", datetime.fromtimestamp(int(ts), BJ))
                print("  ET ", datetime.fromtimestamp(int(ts), ET))
        for k, v in obj.items():
            if k in ("startTime", "startTimestamp"):
                continue
            walk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:30]):
            walk(v, f"{path}[{i}]")

# only sample matches
matches = []
if isinstance(d, dict):
    for key in ("atp", "wta", "players", "items", "top20", "data"):
        if key in d:
            print("section", key, type(d[key]))
    # try common shapes
    for tour in ("atp", "wta"):
        section = d.get(tour) or d.get(tour.upper())
        if isinstance(section, list):
            for p in section[:5]:
                ms = p.get("matches") or p.get("events") or []
                for m in ms[:3]:
                    matches.append((tour, p.get("name") or p.get("player"), m))

print("found matches", len(matches))
for tour, player, m in matches[:12]:
    print("---", tour, player)
    print("  fields", {k: m.get(k) for k in m.keys() if "time" in k.lower() or "start" in k.lower() or k in ("home","away","opponent","status")})
    ts = m.get("startTimestamp")
    st = m.get("startTime")
    if ts:
        print("  ts UTC", datetime.fromtimestamp(int(ts), timezone.utc).strftime("%m-%d %H:%M"))
        print("  ts BJ ", datetime.fromtimestamp(int(ts), BJ).strftime("%m-%d %H:%M"))
    print("  startTime field", st)

# Also check how monitor builds startTime
from pathlib import Path
for f in Path("/home/ubuntu/sofascore-tennis-scraper").glob("*.py"):
    text = f.read_text(encoding="utf-8", errors="ignore")
    if "startTime" in text:
        for i, line in enumerate(text.splitlines(), 1):
            if "startTime" in line:
                print(f"{f.name}:{i}: {line.strip()[:140]}")
