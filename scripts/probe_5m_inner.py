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
if up:
    print("top up", up[:3])
if dn:
    print("top dn", dn[:3])

with quick_trade.state_lock:
    lb = dict(quick_trade.state.get("leaderboard") or {})
    print("api state up", lb.get("up_count"), "dn", lb.get("dn_count"), "scan", lb.get("scan_block"))
    print("state round_ts", quick_trade.state.get("round_ts"), "round_end", quick_trade.state.get("round_end"))

# recent rounds history
print("=== last 4 rounds chain ===")
for i in range(4):
    rr = r - i * 300
    tt = olb.get_round_token_ids(rr)
    if not tt:
        print(rr, "no tids")
        continue
    s = olb.ts_to_block(w3, rr)
    e = olb.ts_to_block(w3, rr + 300)
    lg = olb.scan_transfers(w3, s, e, quiet=True)
    nbb, _ = olb.build_balances(lg, set(tt.values()), w3)
    u, d, _ = olb.net_positions(nbb, tt)
    print(rr, "up", len(u), "dn", len(d), "logs", len(lg))
