#!/usr/bin/env python3
import json
import subprocess
from collections import Counter

code = r'''
import time, json
from collections import Counter
import onchain_leaderboard as olb

w3 = olb.Web3(olb.Web3.HTTPProvider(olb.RPC_URL))
now = int(time.time())

for prefix, dur in [("5m", 300), ("15m", 900), ("1h", 3600)]:
    r = now - (now % dur)
    kw = {"prefix": prefix} if prefix != "5m" else {}
    tids = olb.get_round_token_ids(r, **kw)
    print("===", prefix, "round", r, "===")
    print("tids", json.dumps(tids))
    if not tids:
        continue
    target = set(tids.values())
    start = olb.ts_to_block(w3, r)
    tip = w3.eth.block_number
    logs = olb.scan_transfers(w3, start, tip, quiet=True)
    matched = 0
    tid_counter = Counter()
    for log in logs:
        data = log["data"]
        if isinstance(data, str):
            data = bytes.fromhex(data[2:])
        elif hasattr(data, "hex"):
            data = bytes(data)
        tid = str(int.from_bytes(data[:32], "big"))
        if tid in target:
            matched += 1
            tid_counter[tid] += 1
    print("blocks", start, tip, "logs", len(logs), "matched", matched, "tid_hits", dict(tid_counter))
    nb, _ = olb.build_balances(logs, target, w3)
    for label, tid in tids.items():
        raw = {a: round(s, 2) for a, s in nb.get(tid, {}).items() if abs(s) > 0.01}
        print(" ", label, "raw_holders", len(raw), "sample", list(raw.items())[:2])
    up, dn, hedged = olb.net_positions(nb, tids)
    print(" net", len(up), len(dn), "hedged", len(hedged))

# check if ANY recent 5m round in last hour has activity
print("=== recent 5m rounds ===")
for i in range(6):
    r = (now - (now % 300)) - i * 300
    tids = olb.get_round_token_ids(r)
    if not tids:
        print(r, "no tids"); continue
    start = olb.ts_to_block(w3, r)
    end = olb.ts_to_block(w3, r + 300)
    logs = olb.scan_transfers(w3, start, end, quiet=True)
    nb, _ = olb.build_balances(logs, set(tids.values()), w3)
    up, dn, _ = olb.net_positions(nb, tids)
    print(r, "logs", len(logs), "up", len(up), "dn", len(dn))
'''

print(subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", code],
    text=True,
    stderr=subprocess.STDOUT,
    timeout=180,
))
