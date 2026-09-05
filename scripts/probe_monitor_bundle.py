#!/usr/bin/env python3
import json
import urllib.request

def get(path):
    req = urllib.request.Request(
        f"http://127.0.0.1:9004{path}",
        headers={"Authorization": "Bearer sofascore-monitor-2026"},
    )
    return json.load(urllib.request.urlopen(req, timeout=15))

d = get("/status")
print("endpoints", json.dumps(d.get("endpoints"), ensure_ascii=False, indent=2))
print("latest_bundle", json.dumps(d.get("latest_bundle"), ensure_ascii=False, indent=2)[:1500])

import os
out = "/home/ubuntu/sofascore-tennis-scraper/output"
print("output files", os.listdir(out)[-10:] if os.path.isdir(out) else "missing")
for name in sorted(os.listdir(out)):
    if name.startswith("daily_bundle") and name.endswith(".json"):
        p = os.path.join(out, name)
        with open(p, encoding="utf-8") as f:
            b = json.load(f)
        print("bundle file", name, "keys", list(b.keys())[:30])
        print("  scheduled?", "scheduled" in b, "events", b.get("events"), "date", b.get("date"))
        if "scheduled" in b:
            ts = b["scheduled"].get("tournaments") or []
            print("  tournaments", len(ts), "eventCount", b["scheduled"].get("eventCount"))
        # sample nested
        for k in ("rankingsByPlayer", "oddsByEvent", "eloByEvent", "polymarketByEvent", "live"):
            v = b.get(k)
            if isinstance(v, dict):
                print(f"  {k}", len(v))
            elif v is not None:
                print(f"  {k}", type(v).__name__)
