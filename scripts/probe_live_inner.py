import time, json
import onchain_leaderboard as olb

w3 = olb.Web3(olb.Web3.HTTPProvider(olb.RPC_URL))
now = int(time.time())
r = now - (now % 300)
tids = olb.get_round_token_ids(r)
print('round', r, 'elapsed', now-r)
print('tids ok', bool(tids))
start = olb.ts_to_block(w3, r - 30)
tip = w3.eth.block_number
logs = olb.scan_transfers(w3, start, tip, quiet=True)
nb, _ = olb.build_balances(logs, set(tids.values()), w3)
up, dn, _ = olb.net_positions(nb, tids)
print('chain up', len(up), 'dn', len(dn), 'logs', len(logs))

import quick_trade
with quick_trade.state_lock:
    lb = quick_trade.state.get('leaderboard') or {}
    print('state up', lb.get('up_count'), 'dn', lb.get('dn_count'), 'lb_round', lb.get('round_ts'))
    print('round_ts', quick_trade.state.get('round_ts'), 'token_ids', bool(quick_trade.state.get('token_ids')))
    print('board_prices', quick_trade.state.get('board_prices', {}).get('5m'))
