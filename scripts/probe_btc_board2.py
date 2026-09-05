#!/usr/bin/env python3
import json
import subprocess
import urllib.request

d = json.load(urllib.request.urlopen("http://127.0.0.1:8890/api/state", timeout=8))
print("server_time", d.get("server_time"))
print("round", d.get("round_ts"), "->", d.get("round_end"))
left = (d.get("round_end") or 0) - (d.get("server_time") or 0)
print("left_sec", round(left, 1))
print("crawl_enabled", d.get("crawl_enabled"))
print("crypto", d.get("crypto_current"), "strike5m", d.get("strike"))
for name in ("leaderboard", "leaderboard_15m", "leaderboard_1h"):
    lb = d.get(name) or {}
    print(
        name,
        "up", lb.get("up_count"),
        "dn", lb.get("dn_count"),
        "up_total", lb.get("up_total"),
        "dn_total", lb.get("dn_total"),
    )

logs = subprocess.check_output(["sudo", "docker", "logs", "--tail", "300", "bbbbb-board-1"], stderr=subprocess.STDOUT, text=True, errors="replace")
keys = ("error", "Error", "Exception", "Alchemy", "timeout", "429", "fail", "RPC", "rate limit", "Traceback")
hits = [ln for ln in logs.splitlines() if any(k.lower() in ln.lower() for k in keys)]
print("--- log hits", len(hits), "---")
for ln in hits[-30:]:
    print(ln[:200])
