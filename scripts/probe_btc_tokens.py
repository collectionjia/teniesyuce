#!/usr/bin/env python3
import json
import subprocess
import urllib.request

def gamma(slug):
    url = f"https://gamma-api.polymarket.com/events?slug={slug}"
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)

now_script = r'''
import time
print(int(time.time()))
'''
now = int(subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", now_script], text=True
).strip())
round_ts = now - (now % 300)
print("now", now, "round_ts", round_ts)

for ts in [round_ts, round_ts - 300, round_ts - 600]:
    slug = f"btc-updown-5m-{ts}"
    try:
        ev = gamma(slug)
        if not ev:
            print(slug, "NO EVENT")
            continue
        m = ev[0]["markets"][0]
        tokens = json.loads(m["clobTokenIds"]) if isinstance(m["clobTokenIds"], str) else m["clobTokenIds"]
        outcomes = json.loads(m["outcomes"]) if isinstance(m["outcomes"], str) else m["outcomes"]
        print(slug, "outcomes", outcomes, "tokens", [t[:20]+"..." for t in tokens])
        print("  active", m.get("active"), "closed", m.get("closed"), "volume", m.get("volume"))
    except Exception as e:
        print(slug, "ERR", e)

# compare with board internal
board_script = f'''
import onchain_leaderboard as olb
for ts in [{round_ts}, {round_ts - 300}]:
    t = olb.get_round_token_ids(ts)
    print("board", ts, t)
'''
print("--- board ---")
print(subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", board_script], text=True
))

# scan prev round for transfers
scan_script = f'''
import onchain_leaderboard as olb
w3 = olb.Web3(olb.Web3.HTTPProvider(olb.RPC_URL))
tip = w3.eth.block_number
prev = {round_ts - 300}
tids = olb.get_round_token_ids(prev)
if not tids:
    print("no prev tids"); raise SystemExit
start = olb.ts_to_block(w3, prev)
end = olb.ts_to_block(w3, prev + 300)
logs = olb.scan_transfers(w3, start, end, quiet=True)
target = set(tids.values())
nb, _ = olb.build_balances(logs, target, w3)
up, dn, _ = olb.net_positions(nb, tids)
print("prev_round", prev, "blocks", start, end, "logs", len(logs), "up", len(up), "dn", len(dn))
'''
print("--- prev round scan ---")
print(subprocess.check_output(
    ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", scan_script], text=True, stderr=subprocess.STDOUT, timeout=120
))
