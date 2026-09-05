#!/usr/bin/env python3
"""Find which Polymarket source matches the site's displayed current price."""
import asyncio, json, time, urllib.request
from datetime import datetime, timezone

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://polymarket.com/",
}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

now = int(time.time())
board = get("http://127.0.0.1:8890/api/state")
rts = int(board.get("round_ts") or (now - now % 300))
print("time", iso(now))
print("BOARD open", f"${float(board.get('strike') or 0):,.2f}", "current", f"${float(board.get('crypto_current') or 0):,.2f}")
print("USER said current wrong example $77,856.41")

# crypto-price for current window
url = (
    f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC"
    f"&eventStartTime={iso(rts)}&variant=fiveminute&endDate={iso(rts+300)}&_={int(time.time()*1000)}"
)
try:
    cp = get(url)
    print("\ncrypto-price", url)
    print(" open", cp.get("openPrice"), "=>", f"${float(cp.get('openPrice') or 0):,.2f}")
    print(" close", cp.get("closePrice"), "=>", (f"${float(cp['closePrice']):,.2f}" if cp.get("closePrice") is not None else None))
    print(" flags", {k: cp.get(k) for k in ("incomplete","completed","cached","timestamp")})
except Exception as e:
    print("crypto-price err", e)

# try without cache buster / with Accept headers like browser
for extra in ("", "&force=1"):
    u2 = (
        f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC"
        f"&eventStartTime={iso(rts)}&variant=fiveminute&endDate={iso(rts+300)}{extra}"
    )
    try:
        d2 = get(u2)
        print("alt", extra or "plain", "close=", d2.get("closePrice"), "open=", round(float(d2.get("openPrice") or 0), 2))
    except Exception as e:
        print("alt err", e)

# Binance / coinbase reference
try:
    print("binance", get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"))
except Exception as e:
    print("binance", e)

async def rtds(sec=6):
    import websockets
    last = {}
    async with websockets.connect("wss://ws-live-data.polymarket.com", ping_interval=20, ping_timeout=10) as ws:
        await ws.send(json.dumps({"action":"subscribe","subscriptions":[
            {"topic":"crypto_prices","type":"*"},
            {"topic":"crypto_prices_chainlink","type":"*"},
        ]}))
        end = time.time()+sec
        while time.time()<end:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
            except asyncio.TimeoutError:
                continue
            try:
                data = json.loads(raw)
            except Exception:
                continue
            p = data.get("payload") or {}
            if not isinstance(p, dict) or p.get("value") is None:
                continue
            topic = data.get("topic")
            sym = str(p.get("symbol") or "").lower()
            key = f"{topic}:{sym}"
            last[key] = {
                "value": float(p.get("value")),
                "full": p.get("full_accuracy_value"),
                "ts": p.get("timestamp"),
            }
    return last

print("\nRTDS snapshot...")
last = asyncio.run(rtds(8))
for k in sorted(last):
    if "btc" in k:
        v = last[k]
        print(k, f"${v['value']:,.2f}", "full=", v["full"])
