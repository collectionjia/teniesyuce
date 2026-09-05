#!/usr/bin/env python3
"""Probe which live feed matches Polymarket UI current price."""
import asyncio, json, time, urllib.request
from datetime import datetime, timezone

UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}

def http_get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

async def sample_rtds(seconds=8):
    import websockets
    out = {"chainlink": None, "crypto_prices": None, "raw_topics": set(), "samples": []}
    async with websockets.connect(
        "wss://ws-live-data.polymarket.com",
        ping_interval=20, ping_timeout=10, close_timeout=5,
    ) as ws:
        await ws.send(json.dumps({
            "action": "subscribe",
            "subscriptions": [
                {"topic": "crypto_prices_chainlink", "type": "*"},
                {"topic": "crypto_prices", "type": "*"},
            ],
        }))
        end = time.time() + seconds
        while time.time() < end:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
            except asyncio.TimeoutError:
                continue
            if not raw or not str(raw).strip():
                continue
            try:
                data = json.loads(raw)
            except Exception:
                continue
            topic = data.get("topic") or data.get("type")
            out["raw_topics"].add(str(topic))
            payload = data.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            sym = str(payload.get("symbol") or payload.get("pair") or "").lower()
            val = payload.get("value") or payload.get("price") or payload.get("p")
            if val is None:
                continue
            try:
                price = float(val)
            except Exception:
                continue
            sample = {"topic": topic, "symbol": sym, "price": price, "keys": sorted(payload.keys())}
            if len(out["samples"]) < 12:
                out["samples"].append(sample)
            if "btc" in sym:
                if "chainlink" in str(topic):
                    out["chainlink"] = price
                else:
                    out["crypto_prices"] = price
    out["raw_topics"] = sorted(out["raw_topics"])
    return out

def main():
    d = http_get("http://127.0.0.1:8890/api/state")
    print("board open", f"${float(d.get('strike') or 0):,.2f}")
    print("board current", f"${float(d.get('crypto_current') or 0):,.2f}")
    print("user current target ~ $77,882.24")
    try:
        b = http_get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")
        print("binance", b)
    except Exception as e:
        print("binance err", e)
    try:
        # coinbase
        c = http_get("https://api.coinbase.com/v2/prices/BTC-USD/spot")
        print("coinbase", c)
    except Exception as e:
        print("coinbase err", e)

    print("\nSampling RTDS...")
    res = asyncio.get_event_loop().run_until_complete(sample_rtds(10))
    print("topics", res["raw_topics"])
    print("chainlink btc", res["chainlink"])
    print("crypto_prices btc", res["crypto_prices"])
    print("samples:")
    for s in res["samples"]:
        print(" ", s)

if __name__ == "__main__":
    main()
