#!/usr/bin/env python3
import asyncio, json, time, urllib.request

def board():
    req = urllib.request.Request("http://127.0.0.1:8890/api/state", headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

async def live(sec=6):
    import websockets
    last = {"btcusdt": None, "btc/usd": None}
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
            if not isinstance(p, dict):
                continue
            sym = str(p.get("symbol") or "").lower()
            val = p.get("value")
            if val is None:
                continue
            topic = data.get("topic")
            if topic == "crypto_prices" and sym == "btcusdt":
                last["btcusdt"] = float(val)
            if topic == "crypto_prices_chainlink" and sym == "btc/usd":
                last["btc/usd"] = float(val)
    return last

d = board()
print("board open", round(float(d.get("strike") or 0), 2), "current", round(float(d.get("crypto_current") or 0), 2))
print("sampling feeds...")
last = asyncio.run(live(8))
print("live btcusdt", last["btcusdt"], "chainlink", last["btc/usd"])
if last["btcusdt"] and d.get("crypto_current"):
    print("diff board-btcusdt", float(d.get("crypto_current")) - last["btcusdt"])
