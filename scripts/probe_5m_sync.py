#!/usr/bin/env python3
import json
import urllib.request

d = json.load(urllib.request.urlopen("http://127.0.0.1:8890/api/state", timeout=8))
lb = d.get("leaderboard") or {}
print("round_ts", d.get("round_ts"), "lb_round_ts", lb.get("round_ts"), "match", d.get("round_ts") == lb.get("round_ts"))
print("round_end", d.get("round_end"), "lb_round_end", lb.get("round_end"))
print("up", lb.get("up_count"), "dn", lb.get("dn_count"), "strike", d.get("strike"), "crypto", d.get("crypto_current"))
print("left", round((d.get("round_end") or 0) - (d.get("server_time") or 0), 1))
