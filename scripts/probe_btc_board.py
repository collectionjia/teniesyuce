#!/usr/bin/env python3
import json
import urllib.request
import subprocess

def get(url):
    return json.load(urllib.request.urlopen(url, timeout=8))

d = get("http://127.0.0.1:8890/api/state")
print("crawl_enabled", d.get("crawl_enabled"))
print("server_time", d.get("server_time"))
print("round", d.get("round_ts"), "->", d.get("round_end"))
print("crypto", d.get("crypto_current"), "strike", d.get("strike"))
lb = d.get("leaderboard") or {}
print("lb up/dn", lb.get("up_count"), lb.get("dn_count"), "winners", (lb.get("winners") or {}).get("side"))
print("active_market", d.get("active_market"), "market_label", d.get("market_label"))

# from inside server container
out = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-server-1", "wget", "-qO-", "--timeout=5", "http://board:8890/api/state"],
    text=True,
)
s = json.loads(out)
print("via server crawl", s.get("crawl_enabled"), "up", (s.get("leaderboard") or {}).get("up_count"))

# compose env for board
print("--- board env ---")
print(subprocess.check_output(["sudo", "docker", "inspect", "bbbbb-board-1", "--format", "{{json .Config.Env}}"], text=True)[:500])
