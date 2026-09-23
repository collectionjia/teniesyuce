"""P1 baseline runner.

Loads games.csv, walks through 1999-2024 with Elo + MoV + home advantage + season reversion,
computes metrics.

Defaults (P1 baseline):
    K = 20, HomeAdv = 65, MOV c = 2.2, Reversion = 0.40 → 1500
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from elo import EloSystem
from backtest import run_backtest, evaluate, hc_at


def main():
    games = pd.read_csv("data/raw/games.csv")
    games = games[games["game_type"].isin(["REG", "POST"])].copy()
    games = games.dropna(subset=["home_score", "away_score"]).copy()
    games = games.sort_values(["season", "week"]).reset_index(drop=True)
    print(f"Loaded {len(games)} games  seasons {games['season'].min()}-{games['season'].max()}")

    # Train (builds ratings) on 1999-2009, evaluate on 2010-2024
    train_end_season = 2009
    eval_start_season = 2010
    eval_end_season = int(games["season"].max())

    sys_algo = EloSystem(k=20.0, home_adv=65.0, mov_c=2.2, reversion=0.40, start_elo=1500.0)

    # 1) Burn-in: 1999-2009 (Elo updates but we don't record predictions)
    train = games[games["season"] <= train_end_season]
    test = games[games["season"] >= eval_start_season]

    print(f"\n=== Walk-forward backtest (train ≤ {train_end_season}, eval {eval_start_season}-{eval_end_season}) ===")

    # Run full backtest, but only keep eval rows
    df_pred = run_backtest(games, sys_algo, eval_seasons=range(eval_start_season, eval_end_season + 1))

    # Overall metrics
    metrics = evaluate(df_pred)
    print("\n--- OVERALL METRICS ---")
    print(f"N games:       {metrics['n']}")
    print(f"Brier:         {metrics['brier']:.4f}  (target < 0.22)")
    print(f"LogLoss:       {metrics['logloss']:.4f}  (target < 0.65)")
    print(f"Accuracy:      {metrics['overall_acc']:.3f}")

    print("\n--- HIT RATE BY CONFIDENCE ---")
    for t in [0.75, 0.65, 0.55]:
        h = metrics[f"hc{int(t*100)}"]
        if h["n"] == 0:
            print(f"  HC@{int(t*100):>2} : no games")
            continue
        print(f"  HC@{int(t*100):>2} : n={h['n']:>4}  hit_rate={h['hit_rate']:.3f}  avg_pred={h['avg_pred']:.3f}  "
              f"calibration_gap={h['avg_pred']-h['hit_rate']:+.3f}")

    # Per-season breakdown for HC@75
    print("\n--- HC@75 BY SEASON (eval window) ---")
    season_rows = []
    for season, sg in df_pred.groupby("season"):
        h75 = hc_at(sg, 0.75)
        h65 = hc_at(sg, 0.65)
        season_rows.append({
            "season": season,
            "n": len(sg),
            "n_hc75": h75["n"],
            "hc75": h75["hit_rate"] if h75["n"] else None,
            "n_hc65": h65["n"],
            "hc65": h65["hit_rate"] if h65["n"] else None,
            "acc": float((sg["pred_home"] >= 0.5).astype(int).eq(sg["home_win"]).mean()),
        })
    sdf = pd.DataFrame(season_rows)
    print(sdf.to_string(index=False))

    # Save outputs
    out_dir = "data/processed"
    os.makedirs(out_dir, exist_ok=True)
    df_pred.to_csv(os.path.join(out_dir, "p1_predictions.csv"), index=False)
    sdf.to_csv(os.path.join(out_dir, "p1_season_metrics.csv"), index=False)
    print(f"\nWrote: {out_dir}/p1_predictions.csv  ({len(df_pred)} rows)")
    print(f"Wrote: {out_dir}/p1_season_metrics.csv")

    # Final ratings snapshot (top / bottom)
    items = sorted(sys_algo.ratings.items(), key=lambda kv: -kv[1])
    print("\n--- FINAL RATINGS (top 8 / bottom 5) ---")
    for t, r in items[:8]:
        print(f"  {t}: {r:.0f}")
    print("  ...")
    for t, r in items[-5:]:
        print(f"  {t}: {r:.0f}")


if __name__ == "__main__":
    main()