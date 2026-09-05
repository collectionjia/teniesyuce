#!/usr/bin/env python3
import json
import subprocess
import urllib.request

script = r'''
import time, json
import onchain_leaderboard as olb

now = int(time.time())
r = now - (now % 300)
tids = olb.get_round_token_ids(r)
print("round", r)
print("token_ids", json.dumps(tids))
w3 = olb.Web3(olb.Web3.HTTPProvider(olb.RPC_URL))
tip = w3.eth.block_number
print("tip", tip)
from_block = tip - 100
logs = olb.scan_transfers(w3, from_block, tip, quiet=True)
print("logs_last100", len(logs))
if tids:
    target = set(tids.values())
    nb, _ = olb.build_balances(logs, target, w3)
    up, dn, hedged = olb.net_positions(nb, tids)
    print("net up", len(up), "dn", len(dn), "hedged", len(hedged))
    if up:
        print("top up", up[:3])
    if dn:
        print("top dn", dn[:3])
else:
    print("NO token ids for current round")
'''

out = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", script],
    text=True,
    stderr=subprocess.STDOUT,
)
print(out)

d = json.load(urllib.request.urlopen("http://127.0.0.1:8890/api/state", timeout=8))
lb = d.get("leaderboard") or {}
print("api scan_block", lb.get("scan_block"))
print("api up/dn", lb.get("up_count"), lb.get("dn_count"))
