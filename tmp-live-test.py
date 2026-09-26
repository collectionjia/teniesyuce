#!/usr/bin/env python3
import sys
sys.path.insert(0, r"d:\bbbbb\scripts\tennis-monitor")

from tm.env import load_monitor_env
load_monitor_env()

from tm.clients.sofascore import SofascoreClient

with SofascoreClient(skip_warm=True) as c:
    data = c.get_live_tennis_events()
    events = data.get("events") or []
    print(f"count={len(events)}")
    for ev in events[:10]:
        hs = ev.get("homeScore") or {}
        aws = ev.get("awayScore") or {}
        home = (ev.get("homeTeam") or {}).get("name") or "?"
        away = (ev.get("awayTeam") or {}).get("name") or "?"
        st = (ev.get("status") or {}).get("type") if isinstance(ev.get("status"), dict) else ev.get("status")
        if isinstance(hs, dict) and isinstance(aws, dict):
            parts = []
            for k in ("period1", "period2", "period3", "period4", "period5"):
                if hs.get(k) is not None and aws.get(k) is not None:
                    parts.append(f"{hs[k]}-{aws[k]}")
            score = " ".join(parts) if parts else f"{hs.get('current','?')}-{aws.get('current','?')}"
        else:
            score = "?"
        print(f"id={ev.get('id')} {home} vs {away} status={st} score={score}")
    print("requests", c.get_request_stats())
