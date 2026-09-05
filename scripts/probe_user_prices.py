#!/usr/bin/env python3
import json, time, urllib.request
from datetime import datetime, timezone

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Cache-Control": "no-cache",
    "Referer": "https://polymarket.com/",
}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

now = int(time.time())
aligned = now - now % 300
d = get("http://127.0.0.1:8890/api/state")
rts = int(d.get("round_ts") or aligned)
br5 = (d.get("board_rounds") or {}).get("5m") or {}

print("NOW", iso(now), now)
print("BOARD round", rts, iso(rts), "end", d.get("round_end"))
print("BOARD strike/open", d.get("strike"), "=>", f"${float(d.get('strike') or 0):,.2f}")
print("BOARD current", d.get("crypto_current"), "=>", f"${float(d.get('crypto_current') or 0):,.2f}")
print("BOARD 5m", br5)
print("USER reported open $77,893.70 current $77,882.24")

# Official API for board round and current aligned window
for label, ts in [("board_rts", rts), ("aligned_now", aligned), ("aligned-300", aligned - 300), ("aligned+300", aligned + 300)]:
    url = (
        f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC"
        f"&eventStartTime={iso(ts)}&variant=fiveminute&endDate={iso(ts+300)}&_={int(time.time()*1000)}"
    )
    try:
        data = get(url)
        op = data.get("openPrice")
        cp = data.get("closePrice")
        print(f"\nAPI {label} {iso(ts)}->{iso(ts+300)}")
        print(f"  open={op} => ${float(op or 0):,.2f}" if op else f"  open={op}")
        print(f"  close={cp} => ${float(cp):,.2f}" if cp is not None else f"  close={cp}")
        print(f"  incomplete={data.get('incomplete')} completed={data.get('completed')} cached={data.get('cached')}")
    except Exception as e:
        print(f"\nAPI {label} ERR", e)

# gamma event for slug
slug = f"btc-updown-5m-{rts}"
print("\nGAMMA", slug)
try:
    ev = get(f"https://gamma-api.polymarket.com/events?slug={slug}")
    if isinstance(ev, list) and ev:
        m = (ev[0].get("markets") or [{}])[0]
        print("title", ev[0].get("title"))
        print("eventStartTime", m.get("eventStartTime"))
        print("outcomePrices", m.get("outcomePrices"))
except Exception as e:
    print(e)

# Also try lowercase symbol / without endDate / unix seconds
alts = [
    f"https://polymarket.com/api/crypto/crypto-price?symbol=btc&eventStartTime={iso(rts)}&variant=fiveminute&endDate={iso(rts+300)}",
    f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime={rts}&variant=fiveminute&endDate={rts+300}",
]
print("\nALT URLS")
for u in alts:
    try:
        data = get(u)
        print(u)
        print(" ", {k: data.get(k) for k in ("openPrice","closePrice","incomplete","completed")})
    except Exception as e:
        print(u, "->", e)
