#!/usr/bin/env python3
import asyncio, json, time

async def main():
    import websockets
    subs_variants = [
        [{"topic": "crypto_prices_twap_sixty", "type": "*"}],
        [{"topic": "crypto_prices_twap_thirty", "type": "*"}],
        [{"topic": "crypto_prices_twap_sixty", "type": "*", "filters": ""}],
        [{"topic": "crypto_prices_twap_sixty", "type": "update", "filters": json.dumps({"symbol": "btc/usd"})}],
        [{"topic": "crypto_prices_chainlink", "type": "*", "filters": ""}],
        [{"topic": "crypto_prices", "type": "*", "filters": ""}],
    ]
    async with websockets.connect("wss://ws-live-data.polymarket.com", ping_interval=5, ping_timeout=10) as ws:
        for i, subs in enumerate(subs_variants):
            msg = {"action": "subscribe", "subscriptions": subs}
            await ws.send(json.dumps(msg))
            print("SUB", msg)
        end = time.time() + 15
        n = 0
        while time.time() < end and n < 40:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=3)
            except asyncio.TimeoutError:
                print("timeout")
                continue
            n += 1
            s = raw if isinstance(raw, str) else raw.decode("utf-8", "ignore")
            if not s.strip():
                print("empty ping?")
                continue
            try:
                data = json.loads(s)
            except Exception:
                print("raw", s[:200])
                continue
            topic = data.get("topic")
            typ = data.get("type")
            p = data.get("payload")
            if isinstance(p, dict):
                sym = p.get("symbol")
                val = p.get("value")
                if sym and "btc" in str(sym).lower():
                    print("HIT", topic, typ, sym, val, "keys", list(p.keys()))
                elif n <= 8:
                    print("msg", topic, typ, "sym", sym, "keys", list(p.keys())[:8])
            else:
                print("msg", topic, typ, type(p).__name__, str(p)[:120])

asyncio.run(main())
