import json, urllib.request
from datetime import datetime, timezone

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

d = get('http://127.0.0.1:8890/api/state')
print('strike', d.get('strike'))
print('crypto_current', d.get('crypto_current'))
print('round_ts', d.get('round_ts'), 'round_end', d.get('round_end'))
print('board_rounds', json.dumps(d.get('board_rounds'), ensure_ascii=False))

rts = int(d.get('round_ts') or 0)
if rts:
    start = datetime.fromtimestamp(rts, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    end = datetime.fromtimestamp(rts + 300, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    urls = [
        f'https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime={start}&variant=fiveminute&endDate={end}',
        f'https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime={start}&variant=fiveminute&endDate={end}&_={int(datetime.now().timestamp())}',
    ]
    for u in urls:
        print('URL', u)
        try:
            print(get(u))
        except Exception as e:
            print('ERR', e)
