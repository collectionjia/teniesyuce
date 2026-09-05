#!/usr/bin/env python3
import json
import subprocess
import urllib.request

TOKEN = "Bearer sofascore-monitor-2026"

def get(url):
    req = urllib.request.Request(url, headers={"Authorization": TOKEN})
    return json.load(urllib.request.urlopen(req, timeout=10))

live = get("http://127.0.0.1:9004/live")
last = live.get("last") or {}
print("monitor live_count", last.get("live_count"), "events", len(last.get("events") or []))

raw = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-redis-1", "redis-cli", "GET", "tennis:bundle:full"],
    text=True,
)
if raw and raw.strip() != "(nil)":
    b = json.loads(raw)
    print("redis events", b.get("events"), "live", b.get("live", {}).get("eventCount"))
    print("redis source", b.get("source"), "fetched_at", b.get("fetched_at"))
else:
    print("redis empty")

bundle = get("http://127.0.0.1:9004/bundle")
print("bundle ok", bundle.get("ok"), "events", bundle.get("scheduled", {}).get("eventCount"))
