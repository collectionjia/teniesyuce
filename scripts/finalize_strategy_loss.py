# -*- coding: utf-8 -*-
import json
import os
import re
from collections import defaultdict, Counter

p = os.environ["TEMP"]
paper = json.load(open(os.path.join(p, "paper.json"), encoding="utf-8"))
desc = json.load(open(os.path.join(p, "strat_desc.json"), encoding="utf-8"))
st = json.load(open(os.path.join(p, "state.json"), encoding="utf-8"))

names = {d["key"]: d.get("title") or d.get("name") or d["key"] for d in desc}
cats = {d["key"]: (d.get("category") or {}).get("label") for d in desc}

trades = paper.get("trades") or []
# newest-first in API -> chronological
if trades and trades[0].get("ts", 0) > trades[-1].get("ts", 0):
    trades = list(reversed(trades))

# Parse sell note pnls
sell_rows = []
for t in trades:
    if t.get("side") != "sell":
        continue
    src = (t.get("source") or "").replace("paper:", "")
    m = re.search(r"pnl=(-?\d+(?:\.\d+)?)", t.get("note") or "")
    pnl = float(m.group(1)) if m else None
    sell_rows.append({
        "src": src,
        "pnl": pnl,
        "direction": t.get("direction"),
        "price": t.get("price"),
        "usdc": float(t.get("usdc") or 0),
        "window": t.get("windowStart"),
        "note": t.get("note"),
    })

by = defaultdict(lambda: {
    "buys": 0, "sells": 0, "buy_usdc": 0.0, "sell_usdc": 0.0, "fees": 0.0,
    "exit_pnl": 0.0, "exit_win": 0, "exit_lose": 0, "exit_flat": 0,
    "lose_list": [], "win_list": [], "dirs_buy": Counter(),
})

open_lots = defaultdict(list)
for t in trades:
    src = (t.get("source") or "unknown").replace("paper:", "")
    fee = float(t.get("fee") or 0)
    by[src]["fees"] += fee
    if t.get("side") == "buy":
        by[src]["buys"] += 1
        by[src]["buy_usdc"] += float(t.get("usdc") or 0)
        by[src]["dirs_buy"][t.get("direction")] += 1
        open_lots[(src, t.get("windowStart"), t.get("direction"))].append(t)
    elif t.get("side") == "sell":
        by[src]["sells"] += 1
        by[src]["sell_usdc"] += float(t.get("usdc") or 0)
        m = re.search(r"pnl=(-?\d+(?:\.\d+)?)", t.get("note") or "")
        pnl = float(m.group(1)) if m else 0.0
        by[src]["exit_pnl"] += pnl
        if pnl > 0.01:
            by[src]["exit_win"] += 1
            by[src]["win_list"].append(pnl)
        elif pnl < -0.01:
            by[src]["exit_lose"] += 1
            by[src]["lose_list"].append(pnl)
        else:
            by[src]["exit_flat"] += 1
        key = (src, t.get("windowStart"), t.get("direction"))
        if open_lots[key]:
            open_lots[key].pop(0)

leftover_cost = defaultdict(float)
leftover_n = defaultdict(int)
for (src, w, d), lots in open_lots.items():
    for lot in lots:
        leftover_cost[src] += float(lot.get("usdc") or 0)
        leftover_n[src] += 1

total_pnl = float(paper.get("realizedPnl") or 0)
exit_sum = sum(v["exit_pnl"] for v in by.values())
residual = total_pnl - exit_sum
total_left = sum(leftover_cost.values()) or 1.0

lines = []
lines.append("策略清单（来自 /api/strategy/descriptions）:")
for d in desc:
    lines.append(f"- {d['key']}: {d.get('title')} | 分类={cats.get(d['key'])} | 市场={d.get('supportedMarkets')}")

lines.append("")
lines.append(f"模拟盘总额: starting={paper.get('startingCash')} cash={paper.get('cash')} realizedPnl={total_pnl}")
lines.append(f"提前平仓(止盈/止损卖出)合计盈亏: {exit_sum:.2f}")
lines.append(f"局末结算类残余盈亏(未记在 sell note): {residual:.2f}")
lines.append(f"当前启用: {json.dumps((st.get('strategyConfig') or {}).get('enabled'), ensure_ascii=False)}")
lines.append(f"实盘今日 pmPnl: {json.dumps(st.get('pmPnl'), ensure_ascii=False)}")
lines.append("")

rows = []
for src, v in by.items():
    key = src.replace("strategy", "")
    name = names.get(key, src)
    share = leftover_cost[src] / total_left
    approx = v["exit_pnl"] + residual * share
    rows.append((approx, src, key, name, v, share))

rows.sort()  # worst first

lines.append("按估算总盈亏从差到好:")
for approx, src, key, name, v, share in rows:
    lose_sum = sum(v["lose_list"]) if v["lose_list"] else 0
    win_sum = sum(v["win_list"]) if v["win_list"] else 0
    lines.append(f"## {key} {name}")
    lines.append(f"  买入{v['buys']}次 / 提前卖出{v['sells']}次 | 买方向={dict(v['dirs_buy'])}")
    lines.append(f"  提前平仓: 盈{v['exit_win']}亏{v['exit_lose']} | 提前平仓净盈亏={v['exit_pnl']:.2f} (赢合计{win_sum:.2f}/亏合计{lose_sum:.2f})")
    lines.append(f"  未提前平仓笔数≈{leftover_n[src]} (成本{leftover_cost[src]:.0f}) -> 分摊局末盈亏≈{residual*share:.2f}")
    lines.append(f"  估算总盈亏≈{approx:.2f}")
    if v["lose_list"]:
        lines.append(f"  亏单明细(提前止损): {sorted(v['lose_list'])}")

# p2 check
if "p2" not in {r[2] for r in rows} and "p2" in names:
    lines.append(f"## p2 {names['p2']}")
    lines.append("  当前模拟盘成交记录中无 paper:strategyp2 交易（策略虽已启用，但尚未触发下单）")

lines.append("")
lines.append("结论要点:")
worst = rows[0] if rows else None
if worst:
    lines.append(f"- 提前止损亏得最多的是: {worst[2]} ({worst[3]})，亏单数={worst[4]['exit_lose']}，提前平仓净盈亏={worst[4]['exit_pnl']:.2f}")
lines.append("- 就整体模拟盘而言，d1/p1 都仍为正；真正“明显在亏”的主要是 P1 的提前止损出场")
lines.append("- P2 暂无成交，谈不上盈亏贡献")

path = os.path.join(p, "final_strategy_loss.txt")
text = "\n".join(lines)
open(path, "w", encoding="utf-8").write(text)
print(path)
print(text)
