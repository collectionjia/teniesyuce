#!/usr/bin/env python3
import json
import subprocess

def redis_bundle():
    raw = subprocess.check_output(
        ["docker", "exec", "bbbbb-redis-1", "redis-cli", "get", "tennis:bundle:full"],
        text=True,
    )
    if not raw or raw == "(nil)":
        print("redis: empty")
        return
    d = json.loads(raw)
    print("redis events", d.get("events"), "date", d.get("date"))
    print("redis scheduled", (d.get("scheduled") or {}).get("eventCount"))
    print("redis live", (d.get("live") or {}).get("eventCount"))

if __name__ == "__main__":
    redis_bundle()
