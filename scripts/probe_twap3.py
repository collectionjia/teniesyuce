#!/usr/bin/env python3
import asyncio, json, time, urllib.request

async def main():
    import websockets
    async with websockets.connect("wss://ws-live-data.polymarket.com", ping_interval=5, ping_timeout=10) as ws:
        await ws.send(json.dumps({
            "action": "subscribe",
            "subscriptions": [
                {"topic": "crypto_prices_twap_sixty", "type": "*", "filters": ""},
                {"topic": "crypto_prices_twap_thirty", "type": "*", "filters": ""},
            ],
        }))
        end = time.time() + 10
        while time.time() < end:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
            except asyncio.TimeoutError:
                continue
            if not raw or not str(raw).strip():
                continue
            data = json.loads(raw)
            topic = data.get("topic")
            typ = data.get("type")
            p = data.get("payload")
            if not isinstance(p, dict):
                continue
            sym = str(p.get("symbol") or "").lower()
            if "btc" not in sym:
                continue
            print("type", typ, "topic", topic)
            print(" payload keys", list(p.keys()))
            if p.get("value") is not None:
                print(" value", p.get("value"), "window_s", p.get("window_s"))
            if isinstance(p.get("data"), list):
                print(" data len", len(p["data"]), "tail", p["data"][-3:])
            print("---")

# gamma market config
now = int(time.time())
rts = now - now % 300
slug = f"btc-updown-5m-{rts}"
req = urllib.request.Request(
    f"https://gamma-api.polymarket.com/events?slug={slug}",
    headers={"User-Agent": "Mozilla/5.0"},
)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        ev = json.loads(r.read().decode())
    if isinstance(ev, list) and ev:
        m = (ev[0].get("markets") or [{}])[0]
        for k in sorted(m.keys()):
            lk = k.lower()
            if any(x in lk for x in ("twap", "crypto", "price", "beat", "meta", "config", "lookback")):
                print("gamma", k, "=", m.get(k))
        # nested eventMetadata?
        print("eventMetadata", ev[0].get("eventMetadata"))
except Exception as e:
    print("gamma err", e)

print("\nWS:")
asyncio.run(main())
