import json
from monitor_env import load_monitor_env

load_monitor_env()
from sofascore_client import SofascoreClient

c = SofascoreClient()
c.warm_up()
r = c._api_get("event/16901491/odds/1/all")
markets = r.get("markets") or []
print("markets", len(markets))
for i, m in enumerate(markets[:5]):
    print("---", i, m.get("marketName") or m.get("name"), m.get("marketGroup"))
    choices = m.get("choices") or []
    for ch in choices[:2]:
        print(" ", ch.get("name"), ch.keys())

# winning odds
w = c._api_get("event/16901491/provider/1/winning-odds")
print("winning", json.dumps(w)[:400])
