#!/usr/bin/env python3
import json, time, urllib.request
from datetime import datetime, timezone

UA = {"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache", "Accept": "application/json"}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
        return json.loads(raw.decode("utf-8") or "null")

def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

now = int(time.time())
d = get("http://127.0.0.1:8890/api/state")
rts = int(d.get("round_ts") or (now - now % 300))
print("=== BOARD ===")
print("server_time", d.get("server_time"), "now", now)
print("round_ts", rts, iso(rts), "end", d.get("round_end"))
print("strike", d.get("strike"))
print("crypto_current", d.get("crypto_current"))
print("board_rounds", json.dumps(d.get("board_rounds"), indent=2))

variants = [
    ("5m", "fiveminute", 300, rts),
    ("15m", "fifteenminute", 900, now - now % 900),
    ("15m-five", "fiveminute", 900, now - now % 900),
    ("1h", "onehour", 3600, now - now % 3600),
    ("1h-five", "fiveminute", 3600, now - now % 3600),
]

print("\n=== crypto-price ===")
for label, variant, dur, ts in variants:
    url = (
        f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC"
        f"&eventStartTime={iso(ts)}&variant={variant}&endDate={iso(ts+dur)}&_={now}"
    )
    try:
        data = get(url)
        print(f"{label}: open={data.get('openPrice')} close={data.get('closePrice')} incomplete={data.get('incomplete')} completed={data.get('completed')}")
        print(" ", url)
    except Exception as e:
        print(f"{label}: ERR {e}")
        print(" ", url)

slug = f"btc-updown-5m-{rts}"
print("\n=== gamma", slug, "===")
try:
    ev = get(f"https://gamma-api.polymarket.com/events?slug={slug}")
    if isinstance(ev, list) and ev:
        e0 = ev[0]
        print("title", e0.get("title"))
        print("start", e0.get("startDate"), "end", e0.get("endDate"))
        m = (e0.get("markets") or [{}])[0]
        for k in sorted(m.keys()):
            if any(x in k.lower() for x in ("price", "beat", "line", "open", "close", "strike", "event")):
                print(f"  market.{k} =", m.get(k))
    else:
        print("empty", ev)
except Exception as e:
    print("gamma err", e)

print("\n=== price-to-beat endpoints ===")
for path in (
    f"https://polymarket.com/api/equity/price-to-beat/{slug}",
    f"https://polymarket.com/api/crypto/price-to-beat/{slug}",
    f"https://polymarket.com/api/price-to-beat/{slug}",
):
    try:
        data = get(path)
        print(path, "->", data)
    except Exception as e:
        print(path, "->", e)

# Chainlink via RTDS not available here; compare Binance for reference
print("\n=== binance ===")
try:
    b = get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")
    print(b)
except Exception as e:
    print(e)
