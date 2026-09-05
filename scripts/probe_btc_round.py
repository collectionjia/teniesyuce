#!/usr/bin/env python3
import json
import subprocess

script = r'''
import time, json
from collections import defaultdict
import onchain_leaderboard as olb

now = int(time.time())
round_ts = now - (now % 300)
round_end = round_ts + 300
tids = olb.get_round_token_ids(round_ts)
print("now", now, "round", round_ts, "elapsed", now - round_ts)
print("token_ids", json.dumps(tids))
if not tids:
    raise SystemExit("no token ids")

w3 = olb.Web3(olb.Web3.HTTPProvider(olb.RPC_URL))
tip = w3.eth.block_number
start_block = olb.ts_to_block(w3, round_ts)
print("start_block_est", start_block, "tip", tip, "span", tip - start_block)

target = set(tids.values())
# also include 15m/1h for comparison
for prefix in ("15m", "1h"):
    dur = 900 if prefix == "15m" else 3600
    r = now - (now % dur)
    et = olb.get_round_token_ids(r, prefix=prefix)
    print(prefix, "round", r, "tids", et)

logs = olb.scan_transfers(w3, start_block, tip, quiet=False)
print("logs_round_span", len(logs))

# count logs matching each token id
match_counts = defaultdict(int)
for log in logs:
    data = log["data"]
    if isinstance(data, str):
        data = bytes.fromhex(data[2:])
    elif hasattr(data, "hex"):
        data = bytes(data)
    tid = str(int.from_bytes(data[:32], "big"))
    if tid in target:
        match_counts[tid] += 1
print("matching_logs", dict(match_counts))

nb, _ = olb.build_balances(logs, target, w3)
for tid in target:
    holders = {a: s for a, s in nb.get(tid, {}).items() if abs(s) > 0.01}
    print("tid", tid[:20], "...", "holders", len(holders))
    if holders:
        top = sorted(holders.items(), key=lambda x: -abs(x[1]))[:5]
        print("  top", top)

up, dn, hedged = olb.net_positions(nb, tids)
print("net up", len(up), "dn", len(dn), "hedged", len(hedged))
print("FILTER_MARKET_MAKERS", olb.FILTER_MARKET_MAKERS)

# check saved file for last round
import glob, os
save_dir = os.path.join(os.path.dirname(olb.__file__), "持仓")
files = sorted(glob.glob(os.path.join(save_dir, "*.txt")))[-5:]
print("recent saves", files)
'''

out = subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", script],
    text=True,
    stderr=subprocess.STDOUT,
    timeout=120,
)
print(out)
