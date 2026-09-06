import json
from pathlib import Path
p = sorted(Path("/opt/yuce/bbbbb/scripts/sofascore-monitor/output").glob("daily_bundle_*.json"))[-1]
d = json.loads(p.read_text())
ev = (d.get("scheduled") or {}).get("tournaments") or []
first = (ev[0].get("events") or [{}])[0] if ev else {}
print("file", p.name)
print("events", d.get("events"))
print("rankings", len(d.get("rankingsByPlayer") or {}))
print("odds", len(d.get("oddsByEvent") or {}))
print("birth", len(d.get("birthYearByPlayer") or {}))
print("sample keys", sorted(first.keys()) if first else [])
print("sample level/gender/ground", first.get("level"), first.get("gender"), first.get("groundLabel"))
