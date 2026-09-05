#!/usr/bin/env python3
import asyncio, json, time, urllib.request

def board():
    req = urllib.request.Request("http://127.0.0.1:8890/api/state", headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

async def probe(sec=12):
    import websockets
    topics = [
        "crypto_prices",
        "crypto_prices_chainlink",
        "crypto_prices_twap_thirty",
        "crypto_prices_twap_sixty",
        "crypto_prices_chainlink_twap",
        "prices.crypto.chainlink.twap",
    ]
    last = {}
    seen_topics = set()
    async with websockets.connect("wss://ws-live-data.polymarket.com", ping_interval=20, ping_timeout=10) as ws:
        await ws.send(json.dumps({
            "action": "subscribe",
            "subscriptions": [{"topic": t, "type": "*"} for t in topics],
        }))
        end = time.time() + sec
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
            topic = str(data.get("topic") or "")
            seen_topics.add(topic)
            p = data.get("payload")
            if isinstance(p, dict) and p.get("value") is not None:
                sym = str(p.get("symbol") or "").lower()
                if "btc" in sym:
                    last[f"{topic}:{sym}"] = {
                        "value": float(p["value"]),
                        "full": p.get("full_accuracy_value"),
                        "keys": sorted(p.keys()),
                        "window": p.get("window") or p.get("window_seconds") or p.get("lookback"),
                    }
            elif isinstance(p, list):
                last[f"{topic}:list"] = {"n": len(p), "sample": p[:1]}
    return seen_topics, last

d = board()
print("board current", round(float(d.get("crypto_current") or 0), 2), "open", round(float(d.get("strike") or 0), 2))
seen, last = asyncio.run(probe())
print("seen topics", sorted(seen))
print("btc values:")
for k, v in sorted(last.items()):
    print(" ", k, v)
