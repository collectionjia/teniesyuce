"""Phase 3: market spread_line feature.

Adds pre-game spread_line as an Elo add-on. Search spread_to_elo (Elo per
point of spread) and combine with prior best params (K=16, HA=50, Rev=0.4).
"""

from __future__ import annotations
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from pipeline import (
    EloSystem, CompositeTracker, update_composite, evaluate, fmt_metrics,
)


EVAL_START = 2010
EVAL_END = 2024


def load_games() -> pd.DataFrame:
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    # How many eval games have spread_line?
    eval_df = df[df["season"].between(EVAL_START, EVAL_END)]
    n_with_spread = eval_df["spread_line"].notna().sum()
    print(f"Eval games with spread_line: {n_with_spread} / {len(eval_df)}")
    return df


def run_with_params(games, K, HA, Rev, spread_to_elo, use_composite=True):
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    sys_algo = EloSystem(k=K, home_adv=HA, reversion=Rev, mov_fn=__import__("pipeline").mov_log,
                          spread_to_elo=spread_to_elo)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons,
                                use_composite=use_composite)
    return evaluate(df_pred), df_pred


def main():
    games = load_games()
    K, HA, Rev = 16.0, 50.0, 0.40
    print(f"Base params: K={K} HA={HA} Rev={Rev}")

    print("\n=== Step A: PURE-ELO baselines (composite OFF) ===")
    print("All spread candidates run on a clean Elo-only baseline.")
    candidates = [0, 8, 12, 16, 20, 24, 28, 32, 36, 40]
    rows = []
    for ste in candidates:
        m, _ = run_with_params(games, K, HA, Rev, spread_to_elo=float(ste), use_composite=False)
        h75 = m["hc75"]; h65 = m["hc65"]; h55 = m["hc55"]
        rows.append({
            "spread_to_elo": ste,
            "brier": m["brier"], "logloss": m["logloss"], "acc": m["acc"],
            "hc75": h75["hit_rate"], "hc75_n": h75["n"],
            "hc65": h65["hit_rate"], "hc65_n": h65["n"],
            "hc55": h55["hit_rate"], "hc55_n": h55["n"],
        })
    df_grid = pd.DataFrame(rows)
    print("\nFull grid (PURE ELO):")
    print(df_grid.to_string(index=False))
    df_grid.to_csv("data/processed/p3_spread_grid.csv", index=False)

    best_idx = int(df_grid["hc75"].idxmax())
    best_ste = float(df_grid.loc[best_idx, "spread_to_elo"])
    print(f"\n>>> BEST (HC@75) spread_to_elo = {best_ste}  "
          f"HC@75={df_grid.loc[best_idx,'hc75']:.3f}({int(df_grid.loc[best_idx,'hc75_n'])})  "
          f"Brier={df_grid.loc[best_idx,'brier']:.4f}")

    best_brier_idx = int(df_grid["brier"].idxmin())
    best_brier_ste = float(df_grid.loc[best_brier_idx, "spread_to_elo"])
    print(f">>> BEST (Brier)  spread_to_elo = {best_brier_ste}  "
          f"Brier={df_grid.loc[best_brier_idx,'brier']:.4f}  "
          f"HC@75={df_grid.loc[best_brier_idx,'hc75']:.3f}")

    # Use HC@75 best
    final_m, df_pred = run_with_params(games, K, HA, Rev, spread_to_elo=best_ste, use_composite=False)
    print(fmt_metrics(f"FINAL (pure Elo, ste={best_ste})", final_m))
    df_pred.to_csv("data/processed/p3_predictions.csv", index=False)

    out = {"K": K, "HA": HA, "Rev": Rev, "spread_to_elo": best_ste,
           "composite": "OFF", "mov": "log"}
    with open("data/processed/p3_best_params.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\nFinal params:")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()