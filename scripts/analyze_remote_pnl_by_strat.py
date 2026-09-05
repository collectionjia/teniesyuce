# -*- coding: utf-8 -*-
import json
import os
import re
from collections import defaultdict

p = os.environ["TEMP"]
paper = json.load(open(os.path.join(p, "paper.json"), encoding="utf-8"))
trades = list(reversed(paper.get("trades") or []))  # chronological if newest-first

# Detect order: check timestamps
if trades and trades[0].get("ts", 0) > trades[-1].get("ts", 0):
    trades = list(reversed(trades))

sell_pnl = defaultdict(float)
sell_count = defaultdict(int)
sell_win = defaultdict(int)
sell_lose = defaultdict(int)

# Match buys to later sells within same window+direction+source
open_lots = defaultdict(list)  # key -> list of buys
settle_est = defaultdict(lambda: {"cost": 0.0, "shares_up": 0.0, "shares_down": 0.0, "fees": 0.0, "buys": 0})

realized = defaultdict(float)
fees = defaultdict(float)
buy_usdc = defaultdict(float)
sell_usdc = defaultdict(float)
stats = defaultdict(lambda: {"buys": 0, "sells": 0, "win": 0, "lose": 0, "flat": 0})

for t in trades:
    src = (t.get("source") or "unknown").replace("paper:", "")
    side = t.get("side")
    direction = t.get("direction")
    window = t.get("windowStart")
    key = (src, window, direction)
    fee = float(t.get("fee") or 0)
    fees[src] += fee

    if side == "buy":
        stats[src]["buys"] += 1
        buy_usdc[src] += float(t.get("usdc") or 0)
        open_lots[key].append(t)
        settle_est[src]["buys"] += 1
    elif side == "sell":
        stats[src]["sells"] += 1
        sell_usdc[src] += float(t.get("usdc") or 0)
        note = t.get("note") or ""
        m = re.search(r"pnl=(-?\d+(?:\.\d+)?)", note)
        pnl = float(m.group(1)) if m else float(t.get("usdc") or 0) - 1.0
        realized[src] += pnl
        sell_pnl[src] += pnl
        sell_count[src] += 1
        if pnl > 0.01:
            stats[src]["win"] += 1
            sell_win[src] += 1
        elif pnl < -0.01:
            stats[src]["lose"] += 1
            sell_lose[src] += 1
        else:
            stats[src]["flat"] += 1
        # consume a lot
        if open_lots[key]:
            open_lots[key].pop(0)

# Remaining open lots would have been settled historically; estimate via inventory change is hard.
# Approximate unsettled leftover at end: current positions are 0, so all old lots settled.
# For leftover lots (no sell), assume binary settlement unknown — use cash accounting residual.

# Residual attribution: total realizedPnl - sum(sell pnls) attributed somehow
total_paper_pnl = float(paper.get("realizedPnl") or 0)
sell_realized_sum = sum(realized.values())
residual = total_paper_pnl - sell_realized_sum

# Count leftover buys per strategy
leftover = defaultdict(list)
for key, lots in open_lots.items():
    src = key[0]
    for lot in lots:
        leftover[src].append(lot)

out = []
out.append(f"paper_total_pnl={total_paper_pnl}")
out.append(f"sell_note_pnl_sum={sell_realized_sum:.4f}")
out.append(f"residual_settle_like={residual:.4f}")
out.append("")

for src in sorted(set(list(stats.keys()) + list(leftover.keys()))):
    left = leftover.get(src) or []
    left_cost = sum(float(x.get("usdc") or 0) for x in left)
    left_fees = sum(float(x.get("fee") or 0) for x in left)
    out.append(f"=== {src} ===")
    out.append(f"buys={stats[src]['buys']} sells={stats[src]['sells']} sell_win={stats[src]['win']} sell_lose={stats[src]['lose']}")
    out.append(f"buy_usdc={buy_usdc[src]:.2f} sell_usdc={sell_usdc[src]:.2f} fees={fees[src]:.2f}")
    out.append(f"early_exit_pnl_from_notes={realized[src]:.2f}")
    out.append(f"unpaired_buys_after_matching={len(left)} cost={left_cost:.2f} fees={left_fees:.2f}")
    # direction mix of leftover
    dirs = defaultdict(int)
    for x in left:
        dirs[x.get("direction")] += 1
    out.append(f"unpaired_dirs={dict(dirs)}")
    # show losing sells
    loses = []
    for t in trades:
        if (t.get("source") or "").endswith(src) and t.get("side") == "sell":
            note = t.get("note") or ""
            m = re.search(r"pnl=(-?\d+(?:\.\d+)?)", note)
            if m and float(m.group(1)) < -0.01:
                loses.append((float(m.group(1)), note, t.get("direction"), t.get("windowStart"), t.get("price")))
    out.append(f"losing_sells={loses}")

# Also parse ALL sell notes ranked
all_sells = []
for t in trades:
    if t.get("side") != "sell":
        continue
    src = (t.get("source") or "").replace("paper:", "")
    note = t.get("note") or ""
    m = re.search(r"pnl=(-?\d+(?:\.\d+)?)", note)
    pnl = float(m.group(1)) if m else None
    all_sells.append((pnl, src, t.get("direction"), t.get("price"), float(t.get("usdc") or 0), note))

out.append("\nALL_SELLS_SORTED:")
for row in sorted(all_sells, key=lambda x: (x[0] is None, x[0] or 0)):
    out.append(str(row))

# Approximate settle residual allocation proportional to unpaired buy costs
total_left_cost = sum(sum(float(x.get("usdc") or 0) for x in v) for v in leftover.values()) or 1
out.append("\nAPPROX_TOTAL_BY_STRATEGY:")
approx = {}
for src in sorted(set(list(stats.keys()) + list(leftover.keys()))):
    left_cost = sum(float(x.get("usdc") or 0) for x in leftover.get(src, []))
    share = left_cost / total_left_cost
    approx_pnl = realized[src] + residual * share
    approx[src] = approx_pnl
    out.append(f"{src}: early_exit={realized[src]:.2f} + residual_share={residual*share:.2f} => approx_total={approx_pnl:.2f}")

path = os.path.join(p, "pnl_by_strategy.txt")
open(path, "w", encoding="utf-8").write("\n".join(out))
print(path)
print("\n".join(out))
