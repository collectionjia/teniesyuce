# -*- coding: utf-8 -*-
import json
import os
from collections import Counter, defaultdict

p = os.environ["TEMP"]
out = []


def w(x):
    out.append(str(x))


desc = json.load(open(os.path.join(p, "strat_desc.json"), encoding="utf-8"))
w("STRATEGIES:")
for d in desc:
    w(json.dumps(d, ensure_ascii=False, indent=2))

paper = json.load(open(os.path.join(p, "paper.json"), encoding="utf-8"))
w(
    "PAPER SUMMARY: "
    + json.dumps(
        {
            k: paper.get(k)
            for k in [
                "enabled",
                "cash",
                "startingCash",
                "realizedPnl",
                "totalPnl",
                "equity",
                "openCost",
                "openValue",
            ]
        },
        ensure_ascii=False,
    )
)
trades = paper.get("trades") or []
w("trade_count=" + str(len(trades)))
src = Counter(t.get("source") or "unknown" for t in trades)
w("sources=" + json.dumps(dict(src), ensure_ascii=False))

by = defaultdict(
    lambda: {
        "buys": 0,
        "sells": 0,
        "buy_usdc": 0.0,
        "sell_usdc": 0.0,
        "fees": 0.0,
        "count": 0,
        "dirs": Counter(),
        "pnls": [],
    }
)
for t in trades:
    s = t.get("source") or "unknown"
    by[s]["count"] += 1
    side = t.get("side")
    if side == "buy":
        by[s]["buys"] += 1
        by[s]["buy_usdc"] += float(t.get("usdc") or 0)
        by[s]["fees"] += float(t.get("fee") or 0)
        by[s]["dirs"][t.get("direction") or "?"] += 1
    elif side == "sell":
        by[s]["sells"] += 1
        by[s]["sell_usdc"] += float(t.get("usdc") or 0)
        by[s]["fees"] += float(t.get("fee") or 0)
    if t.get("pnl") is not None:
        by[s]["pnls"].append(float(t["pnl"]))

w("BY_SOURCE:")
for s, v in sorted(by.items()):
    pnl_sum = sum(v["pnls"]) if v["pnls"] else None
    w(
        f"{s}: count={v['count']} buys={v['buys']} sells={v['sells']} "
        f"buy_usdc={v['buy_usdc']:.2f} sell_usdc={v['sell_usdc']:.2f} "
        f"fees={v['fees']:.2f} dirs={dict(v['dirs'])} pnl_sum={pnl_sum}"
    )

w("lastSettle=" + json.dumps(paper.get("lastSettle"), ensure_ascii=False))

# Reconstruct settle PnL by matching buys within windows if settle events exist
settles = [t for t in trades if t.get("side") == "settle" or t.get("reason") == "window-end"]
w("settle_events=" + str(len(settles)))
for t in settles[-20:]:
    w(json.dumps({k: t.get(k) for k in ["id", "side", "pnl", "summary", "reason", "windowStart", "source", "upWins", "costBasis", "payout"]}, ensure_ascii=False))

# If paper trades only buys, estimate from lastSettle style fields embedded
# Look for any trade with pnl
pnl_trades = [t for t in trades if t.get("pnl") is not None]
w("trades_with_pnl=" + str(len(pnl_trades)))
for t in pnl_trades[-30:]:
    w(json.dumps(t, ensure_ascii=False)[:500])

st = json.load(open(os.path.join(p, "state.json"), encoding="utf-8"))
w("STATE_KEYS=" + ",".join(list(st.keys())))
for k in ["strategy", "strategyConfig", "activeStrategy", "perStrategy", "fairProb", "pmPnl", "pmpnl", "livePnl"]:
    if k in st:
        w(k + "=" + json.dumps(st.get(k), ensure_ascii=False)[:4000])

for k in st:
    lk = k.lower()
    if any(x in lk for x in ["pnl", "trade", "strat", "paper", "history"]):
        val = st[k]
        s = json.dumps(val, ensure_ascii=False)
        w(f"FIELD {k} type={type(val).__name__} len={len(s)} preview={s[:800]}")

# Sample recent trades
w("RECENT_TRADES:")
for t in trades[-25:]:
    w(
        json.dumps(
            {
                k: t.get(k)
                for k in [
                    "side",
                    "direction",
                    "shares",
                    "price",
                    "usdc",
                    "fee",
                    "source",
                    "note",
                    "pnl",
                    "summary",
                    "windowStart",
                    "marketKey",
                    "ts",
                ]
            },
            ensure_ascii=False,
        )
    )

path = os.path.join(p, "analysis_out.txt")
open(path, "w", encoding="utf-8").write("\n".join(out))
print(path)
print("lines", len(out))
