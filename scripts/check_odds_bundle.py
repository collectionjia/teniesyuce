import json
from pathlib import Path
p = Path("/opt/yuce/bbbbb/scripts/sofascore-monitor/output/daily_bundle_2026-09-06.json")
d = json.loads(p.read_text())
print("fetched_at", d.get("fetched_at"))
print("odds", len(d.get("oddsByEvent") or {}))
print("sample", list((d.get("oddsByEvent") or {}).items())[:2])
