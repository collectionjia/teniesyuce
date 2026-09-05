#!/usr/bin/env python3
"""Verify: for 15m/1h, use fiveminute on window START .. START+5m for true open."""
import json, time, urllib.request
from datetime import datetime, timezone

UA = {"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def crypto_price(start, end, variant="fiveminute"):
    url = (
        f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC"
        f"&eventStartTime={iso(start)}&variant={variant}&endDate={iso(end)}&_={int(time.time()*1000)}"
    )
    try:
        data = get(url)
        return url, data
    except Exception as e:
        return url, {"error": str(e)}

now = int(time.time())
d = get("http://127.0.0.1:8890/api/state")
rts5 = int(d.get("round_ts") or (now - now % 300))
ts15 = now - now % 900
ts1h = now - now % 3600

print("board 5m strike", d.get("strike"), "15m", (d.get("board_rounds") or {}).get("15m"))
print()

cases = [
    ("5m-window", rts5, rts5 + 300, "fiveminute"),
    ("5m-open-slice", rts5, rts5 + 300, "fiveminute"),
    ("15m-wrong-variant", ts15, ts15 + 900, "fifteenminute"),
    ("15m-true-open-via-5m", ts15, ts15 + 300, "fiveminute"),
    ("1h-wrong-variant", ts1h, ts1h + 3600, "onehour"),
    ("1h-true-open-via-5m", ts1h, ts1h + 300, "fiveminute"),
]
for name, s, e, v in cases:
    url, data = crypto_price(s, e, v)
    print(name, f"{iso(s)} -> {iso(e)} [{v}]")
    print(" ", data)
    print()
