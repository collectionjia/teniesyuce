import json
from pathlib import Path

p = Path("/tmp/btc_state.json")
d = json.loads(p.read_text(encoding="utf-8"))
print("KEYS")
for k in sorted(d.keys()):
    print(k)
print("---INTERESTING---")
for k in sorted(d.keys()):
    lk = k.lower()
    if any(x in lk for x in ("token", "asset", "condition", "clob", "slug", "market", "price", "round")):
        v = d[k]
        s = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)
        print(f"{k}: {s[:300]}")
