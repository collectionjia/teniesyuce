import json, urllib.request

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

d = get('http://127.0.0.1:8890/api/state')
br = d.get('board_rounds') or {}
print('5m', br.get('5m'))
print('15m', br.get('15m'))
print('1h', br.get('1h'))
print('strike', d.get('strike'), 'crypto', d.get('crypto_current'))

import onchain_leaderboard as olb
with olb._btc_price_lock:
    print('internal', {k: olb._btc_prices.get(k) for k in (
        'strike','current','strike_15m','strike_1h','current_15m','current_1h','_last_15m_ts','_last_1h_ts','round_ts'
    )})
