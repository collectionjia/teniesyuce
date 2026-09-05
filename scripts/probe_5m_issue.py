#!/usr/bin/env python3
import json
import time
import urllib.request
import subprocess

def api_state():
    return json.load(urllib.request.urlopen("http://127.0.0.1:8890/api/state", timeout=8))

def board_exec(code):
    return subprocess.check_output(
        ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", code],
        text=True,
        stderr=subprocess.STDOUT,
        timeout=120,
    )

print("=== API samples ===")
for i in range(4):
    d = api_state()
    lb = d.get("leaderboard") or {}
    br = (d.get("board_rounds") or {}).get("5m") or {}
    left = (d.get("round_end") or 0) - (d.get("server_time") or 0)
    print(
        f"#{i+1} round={d.get('round_ts')} left={left:.0f}s "
        f"up={lb.get('up_count')} dn={lb.get('dn_count')} scan={lb.get('scan_block')} "
        f"strike={d.get('strike')} crypto={d.get('crypto_current')} "
        f"board_rounds_5m={br.get('round_ts')}"
    )
    if i < 3:
        time.sleep(8)

print("\n=== on-chain vs API for current 5m ===")
print(board_exec(r'''
import time, json
import onchain_leaderboard as olb
import quick_trade

w3 = olb.Web3(olb.Web3.HTTPProvider(olb.RPC_URL))
now = int(time.time())
r = now - (now % 300)
tids = olb.get_round_token_ids(r)
print("round", r, "elapsed", now - r)
print("tids", json.dumps(tids))
start = olb.ts_to_block(w3, r - 60)
tip = w3.eth.block_number
logs = olb.scan_transfers(w3, start, tip, quiet=True)
nb, _ = olb.build_balances(logs, set(tids.values()), w3)
up, dn, _ = olb.net_positions(nb, tids)
print("chain scan up", len(up), "dn", len(dn), "logs", len(logs))

with quick_trade.state_lock:
    lb = dict(quick_trade.state.get("leaderboard") or {})
    print("api state up", lb.get("up_count"), "dn", lb.get("dn_count"), "scan", lb.get("scan_block"))
    print("state round_ts", quick_trade.state.get("round_ts"), "round_end", quick_trade.state.get("round_end"))
'''))

print("\n=== recent saved 5m rounds ===")
print(subprocess.check_output([
    "sudo", "docker", "exec", "bbbbb-board-1", "sh", "-c",
    "ls -lt /app/持仓/*.txt 2>/dev/null | head -8; echo '---'; for f in $(ls -t /app/持仓/*.txt 2>/dev/null | head -6); do echo \"FILE $f\"; head -5 \"$f\" | tail -2; done"
], text=True, stderr=subprocess.STDOUT))

print("\n=== resync / round logs ===")
print(subprocess.check_output([
    "sudo", "docker", "logs", "bbbbb-board-1", "2>&1"
], text=True, errors="replace")[-4000:])
