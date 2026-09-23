"""Real-data trend analysis: Elo+XGB vs market-spread on 2025-2026 OOS games.

For each completed 2025-2026 game:
  - Run the live predict() (Elo + spread_threshold + XGB blend)
  - Compute market-implied prob from spread_line (538 heuristic: 24 pts = 100%)
  - Compare Elo pick vs market pick vs actual outcome

Outputs:
  - Overall accuracy of both models
  - Accuracy by spread magnitude bucket
  - Accuracy by Elo confidence tier
  - Disagreement cases (where Elo and market disagree on the pick)
"""

from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import pandas as pd
import numpy as np
from predict import predict

# nflverse convention: spread_line +ve ⇒ home team favored.
# 538 NFL heuristic: 24-point swing = 100% prob ⇒ 1 point ≈ 4.17% prob.
# market_prob_home = 0.5 + spread / 24.0
MARKET_DENOM = 24.0


def market_prob_home(spread: float) -> float:
    return float(np.clip(0.5 + spread / MARKET_DENOM, 0.05, 0.95))


def main():
    games = pd.read_csv("data/raw/games.csv")
    games = games[games["game_type"].isin(["REG", "POST"])].copy()
    games = games.dropna(subset=["home_score", "away_score", "spread_line"]).copy()
    games = games[games["season"].between(2025, 2026)].copy()
    games = games.sort_values(["season", "week"]).reset_index(drop=True)
    print(f"Loaded {len(games)} completed 2025-2026 games with spread\n")

    rows = []
    for _, g in games.iterrows():
        home, away = g["home_team"], g["away_team"]
        spread = float(g["spread_line"])
        pred = predict(home, away, spread=spread, season=int(g["season"]))
        elo_p = pred["win_prob_a"]
        elo_only = pred["win_prob_a_elo_only"]
        market_p = market_prob_home(spread)
        actual_home = int(g["home_score"] > g["away_score"])
        rows.append({
            "season": int(g["season"]),
            "week": int(g["week"]),
            "matchup": f"{away}@{home}",
            "spread": spread,
            "elo_p": elo_p, "elo_only_p": elo_only, "market_p": market_p,
            "actual_home": actual_home,
            "elo_pick_home": elo_p >= 0.5,
            "market_pick_home": market_p >= 0.5,
            "elo_correct": int((elo_p >= 0.5) == actual_home),
            "market_correct": int((market_p >= 0.5) == actual_home),
            "tier": pred["confidence_tier"],
        })

    df = pd.DataFrame(rows)
    n = len(df)
    print("=" * 72)
    print("OVERALL")
    print("=" * 72)
    print(f"  N games (2025-2026 OOS with spread): {n}")
    print(f"  Elo+XGB pick accuracy: {df['elo_correct'].mean():.3f}  "
          f"({df['elo_correct'].sum()}/{n})")
    print(f"  Market spread pick accuracy: {df['market_correct'].mean():.3f}  "
          f"({df['market_correct'].sum()}/{n})")
    if "home_win" in df.columns or True:
        print(f"  Always-pick-home accuracy: {df['actual_home'].mean():.3f}  "
          f"(baseline for home-bias comparison)")

    print()
    print("=" * 72)
    print("BY SPREAD MAGNITUDE (where the market commits hardest)")
    print("=" * 72)
    df["abs_spread"] = df["spread"].abs()
    buckets = [
        (0, 1.5, "pickem (<1.5)"),
        (1.5, 3.5, "small (1.5-3.5)"),
        (3.5, 7,   "medium (3.5-7)"),
        (7, 100,   "big (>=7)"),
    ]
    print(f"  {'Bucket':<18} {'N':>4}  {'Elo acc':>8}  {'Market acc':>10}  "
          f"{'Elo avg_p':>9}  {'Market avg_p':>12}")
    for lo, hi, label in buckets:
        sub = df[(df["abs_spread"] >= lo) & (df["abs_spread"] < hi)]
        if not len(sub): continue
        print(f"  {label:<18} {len(sub):>4}  "
              f"{sub['elo_correct'].mean():>8.3f}  "
              f"{sub['market_correct'].mean():>10.3f}  "
              f"{sub['elo_p'].mean():>9.3f}  "
              f"{sub['market_p'].mean():>12.3f}")

    print()
    print("=" * 72)
    print("BY ELO CONFIDENCE TIER")
    print("=" * 72)
    for t in ["high", "medium", "low"]:
        sub = df[df["tier"] == t]
        if not len(sub): continue
        print(f"  {t:<8} n={len(sub):>3}  Elo acc={sub['elo_correct'].mean():.3f}  "
              f"Market acc={sub['market_correct'].mean():.3f}  "
              f"avg_elo_p={sub['elo_p'].mean():.3f}")

    print()
    print("=" * 72)
    print("DISAGREEMENT: where Elo pick != Market pick")
    print("=" * 72)
    df["disagree"] = df["elo_pick_home"] != df["market_pick_home"]
    nd = int(df["disagree"].sum())
    print(f"  Disagreement count: {nd} / {n} ({nd/n*100:.0f}%)")
    if nd:
        sub = df[df["disagree"]]
        print(f"  When they disagree:")
        print(f"    Elo correct:    {sub['elo_correct'].mean():.3f}")
        print(f"    Market correct: {sub['market_correct'].mean():.3f}")
        # Show examples
        print(f"\n  Top 8 disagreements (largest Elo-market gap):")
        sub = sub.copy()
        sub["gap"] = (sub["elo_p"] - sub["market_p"]).abs()
        for _, r in sub.sort_values("gap", ascending=False).head(8).iterrows():
            correct = "✓Elo" if r["elo_correct"] else ("✓Mkt" if r["market_correct"] else "both wrong")
            print(f"    wk{r['week']:>2} {r['matchup']:<10}  "
                  f"spread={r['spread']:>+5.1f}  Elo={r['elo_p']:.3f}  "
                  f"Mkt={r['market_p']:.3f}  score=actual "
                  f"{correct}")

    print()
    print("=" * 72)
    print("WHEN BOTH WRONG (model AND market fail together)")
    print("=" * 72)
    both_wrong = df[(df["elo_correct"] == 0) & (df["market_correct"] == 0)]
    print(f"  Both wrong: {len(both_wrong)} / {n} ({len(both_wrong)/n*100:.0f}%)")
    if len(both_wrong):
        print(f"  avg spread magnitude: {both_wrong['abs_spread'].mean():.2f}")
        print(f"  tiers: {both_wrong['tier'].value_counts().to_dict()}")

    print()
    print("=" * 72)
    print("BLENDED: trust Elo on high-confidence, market on low-confidence")
    print("=" * 72)
    # Simple rule: if Elo prob >= 0.75 use Elo pick; if <= 0.25 use Elo pick (away);
    # else fall back to market.
    df["hybrid_p"] = df.apply(
        lambda r: r["elo_p"] if (r["tier"] == "high" or (r["elo_p"] >= 0.75 or r["elo_p"] <= 0.25))
                            else (r["elo_p"] * 0.5 + r["market_p"] * 0.5),
        axis=1)
    df["hybrid_correct"] = ((df["hybrid_p"] >= 0.5).astype(int) == df["actual_home"]).astype(int)
    print(f"  Hybrid (Elo high-confidence + 50/50 blend elsewhere) acc: "
          f"{df['hybrid_correct'].mean():.3f}")
    print(f"  vs Elo only: {df['elo_correct'].mean():.3f}")
    print(f"  vs Market only: {df['market_correct'].mean():.3f}")


if __name__ == "__main__":
    main()