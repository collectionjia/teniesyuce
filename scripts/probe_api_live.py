#!/usr/bin/env python3
import json
import time
import urllib.request

def board():
    return json.load(urllib.request.urlopen("http://127.0.0.1:8890/api/state", timeout=8))

print("=== board direct ===")
for i in range(6):
    d = board()
    lb = d.get("leaderboard") or {}
    left = round((d.get("round_end") or 0) - (d.get("server_time") or 0), 1)
    print(f"#{i+1} left={left} round={d.get('round_ts')} lb_r={lb.get('round_ts')} up={lb.get('up_count')} dn={lb.get('dn_count')} crypto={round(d.get('crypto_current') or 0,2)} bp={(d.get('board_prices') or {}).get('5m')}")
    time.sleep(5)
