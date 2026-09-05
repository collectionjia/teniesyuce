#!/usr/bin/env python3
import json
import time
import urllib.request

def state():
    return json.load(urllib.request.urlopen("http://127.0.0.1:8890/api/state", timeout=8))

s1 = state()
print("t1", s1.get("server_time"), "crypto", s1.get("crypto_current"), "up", (s1.get("leaderboard") or {}).get("up_count"), "dn", (s1.get("leaderboard") or {}).get("dn_count"))
wr = (s1.get("winner_records") or [])[:3]
for w in wr:
    print("winner", w.get("round_time"), w.get("actual_winner"), "prev", w.get("prev_side"), "up_n", w.get("up_n"), "dn_n", w.get("dn_n"))
time.sleep(5)
s2 = state()
print("t2", s2.get("server_time"), "crypto", s2.get("crypto_current"), "up", (s2.get("leaderboard") or {}).get("up_count"), "dn", (s2.get("leaderboard") or {}).get("dn_count"))
print("crypto_delta", (s2.get("crypto_current") or 0) - (s1.get("crypto_current") or 0))
print("crawl", s2.get("crawl_enabled"))
