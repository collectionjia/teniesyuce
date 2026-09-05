#!/usr/bin/env python3
import json
import subprocess
import time
import urllib.request

req = urllib.request.Request(
    "http://127.0.0.1:9004/live",
    headers={"Authorization": "Bearer sofascore-monitor-2026"},
)
d = json.load(urllib.request.urlopen(req, timeout=8))
ev = (d.get("last") or {}).get("events") or []
print("live events", len(ev))

raw = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-redis-1", "redis-cli", "GET", "tennis:bundle:full"],
    text=True,
)
bundle = json.loads(raw) if raw and raw.strip() and raw.strip() != "(nil)" else None
if not bundle:
    print("redis empty")
else:
    ids = set()
    statuses = []
    for t in (bundle.get("scheduled") or {}).get("tournaments") or []:
        for e in t.get("events") or []:
            ids.add(str(e.get("id")))
            statuses.append((e.get("status"), e.get("statusType")))
    print("bundle events", len(ids))
    hit = [e for e in ev if str(e.get("id")) in ids]
    print("live matched in bundle", len(hit))
    print("bundle status sample", statuses[:8])
    print("matched live sample", [(e.get("home"), e.get("status"), e.get("statusType")) for e in hit[:5]])

t0 = time.time()
try:
    out = subprocess.check_output(
        [
            "sudo",
            "docker",
            "exec",
            "bbbbb-server-1",
            "wget",
            "-qO-",
            "--timeout=2",
            "--header=Authorization: Bearer sofascore-monitor-2026",
            "http://172.17.0.1:9004/live",
        ],
        text=True,
        stderr=subprocess.STDOUT,
    )
    print("server->monitor ok", round(time.time() - t0, 2), "sec", "bytes", len(out))
    jd = json.loads(out)
    print("from container events", len((jd.get("last") or {}).get("events") or []))
except Exception as e:
    print("server->monitor FAIL", round(time.time() - t0, 2), e)
