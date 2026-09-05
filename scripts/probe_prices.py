#!/usr/bin/env python3
import json
import time
import urllib.request

def get():
    return json.load(urllib.request.urlopen("http://127.0.0.1:8890/api/state", timeout=8))

for i in range(8):
    d = get()
    lb = d.get("leaderboard") or {}
    bp = (d.get("board_prices") or {}).get("5m") or {}
    left = round((d.get("round_end") or 0) - (d.get("server_time") or 0), 1)
    print(
        f"#{i+1} left={left}s round={d.get('round_ts')} "
        f"up_n={lb.get('up_count')} dn_n={lb.get('dn_count')} "
        f"up_p={d.get('up_price')} dn_p={d.get('down_price')} "
        f"bp_up={bp.get('up')} bp_dn={bp.get('down')} "
        f"crypto={round(d.get('crypto_current') or 0, 2)} scan={lb.get('scan_block')}"
    )
    time.sleep(5)
