#!/usr/bin/env python3
from monitor_env import load_monitor_env

load_monitor_env()
from sofascore_client import SofascoreClient

with SofascoreClient() as c:
    r = c._api_get("rankings/type/6")
    n = len(r.get("rankings") or r.get("list") or [])
    print("rankings_atp", n)
    live = c.get_live_tennis_events()
    print("live_events", len(live.get("events") or []))
