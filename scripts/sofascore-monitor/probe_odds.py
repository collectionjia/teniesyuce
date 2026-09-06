from monitor_env import load_monitor_env

load_monitor_env()
from sofascore_client import SofascoreClient

c = SofascoreClient()
c.warm_up()
eid = 16901491
paths = [
    f"event/{eid}/odds/1/all",
    f"event/{eid}/odds/1",
    f"event/{eid}/provider/1/winning-odds",
    f"event/{eid}/odds",
    f"event/{eid}/provider/1/odds",
]
for p in paths:
    try:
        r = c._api_get(p)
        mk = r.get("markets") or r.get("odds") or []
        print(p, "keys", list(r.keys())[:10], "markets", len(mk) if isinstance(mk, list) else type(mk))
    except Exception as e:
        print(p, "ERR", str(e)[:100])
