#!/usr/bin/env python3
import json
import subprocess
import urllib.request

def board_py(code):
    return subprocess.check_output(
        ["sudo", "docker", "exec", "bbbbb-board-1", "python3", "-c", code],
        text=True,
        stderr=subprocess.STDOUT,
        timeout=120,
    )

print("=== server -> board ===")
try:
    out = subprocess.check_output(
        ["sudo", "docker", "exec", "bbbbb-server-1", "wget", "-qO-", "--timeout=8", "http://board:8890/api/state"],
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    d = json.loads(out)
    print("ok server_time", d.get("server_time"), "up", (d.get("leaderboard") or {}).get("up_count"))
except subprocess.CalledProcessError as e:
    print("FAIL", (e.output or str(e))[:500])

print("\n=== scan 15m / 1h ===")
print(board_py(r'''
import time
import onchain_leaderboard as olb
w3 = olb.Web3(olb.Web3.HTTPProvider(olb.RPC_URL))
now = int(time.time())
for prefix, dur in [("5m", 300), ("15m", 900), ("1h", 3600)]:
    r = now - (now % dur)
    tids = olb.get_round_token_ids(r, prefix=prefix if prefix != "5m" else "5m")
    if not tids:
        print(prefix, "no tids"); continue
    start = olb.ts_to_block(w3, r)
    tip = w3.eth.block_number
    logs = olb.scan_transfers(w3, start, tip, quiet=True)
    nb, _ = olb.build_balances(logs, set(tids.values()), w3)
    up, dn, _ = olb.net_positions(nb, tids)
    print(prefix, "elapsed", now-r, "logs", len(logs), "up", len(up), "dn", len(dn))
'''))

print("\n=== container uptime ===")
print(subprocess.check_output(["sudo", "docker", "ps", "--filter", "name=bbbbb-board-1", "--format", "{{.Status}}"], text=True))

print("\n=== CRAWL env ===")
print(subprocess.check_output(["sudo", "docker", "exec", "bbbbb-board-1", "printenv", "CRAWL_ENABLED"], text=True).strip())
print(subprocess.check_output(["sudo", "docker", "exec", "bbbbb-board-1", "cat", "/app/持仓/crawl_enabled.json"], text=True).strip())
