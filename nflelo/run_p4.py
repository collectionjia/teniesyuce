"""Phase 4: conditional spread — apply only when |Elo diff| < threshold.

Grid search: spread_to_elo × spread_threshold on Pure-Elo baseline.
"""

from __future__ import annotations
import sys, os, json, itertools
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from pipeline import EloSystem, CompositeTracker, update_composite, evaluate, fmt_metrics, mov_log


EVAL_START = 2010
EVAL_END = 2024


def load_games():
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    return df


def run_with(games, K, HA, Rev, ste, threshold):
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    sys_algo = EloSystem(k=K, home_adv=HA, reversion=Rev, mov_fn=mov_log,
                          spread_to_elo=ste, spread_threshold=threshold)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons,
                                use_composite=False)
    return evaluate(df_pred), df_pred


def main():
    games = load_games()
    K, HA, Rev = 16.0, 50.0, 0.40
    print(f"Base params: K={K} HA={HA} Rev={Rev}  (composite=OFF)")

    spread_to_elos = [0, 8, 12, 16, 20, 24, 28]
    thresholds    = [0, 60, 80, 100, 120, 150, 200, 300]  # 0 ⇒ always on
    grid = list(itertools.product(spread_to_elos, thresholds))

    print(f"\n=== Grid: {len(grid)} combos ===")
    rows = []
    for i, (ste, thr) in enumerate(grid, 1):
        m, _ = run_with(games, K, HA, Rev, ste, thr)
        h75 = m["hc75"]; h65 = m["hc65"]
        rows.append({
            "spread_to_elo": ste, "spread_threshold": thr,
            "brier": m["brier"], "logloss": m["logloss"], "acc": m["acc"],
            "hc75": h75["hit_rate"], "hc75_n": h75["n"],
            "hc65": h65["hit_rate"], "hc65_n": h65["n"],
        })
        if i % 10 == 0 or i == len(grid):
            print(f"  ... {i}/{len(grid)} done")
    df_grid = pd.DataFrame(rows)
    df_grid.to_csv("data/processed/p4_cond_grid.csv", index=False)

    # Pivot table for readability
    print("\n--- HC@75 pivot (rows=threshold, cols=spread_to_elo) ---")
    pv75 = df_grid.pivot_table(values="hc75", index="spread_threshold", columns="spread_to_elo")
    pv75_n = df_grid.pivot_table(values="hc75_n", index="spread_threshold", columns="spread_to_elo")
    print("HC@75:")
    print(pv75.round(3).to_string())
    print("\nHC@75 n (sample size):")
    print(pv75_n.round(0).to_string())

    print("\n--- Brier pivot ---")
    pv_b = df_grid.pivot_table(values="brier", index="spread_threshold", columns="spread_to_elo")
    print(pv_b.round(4).to_string())

    # Best by HC@75
    best_idx = int(df_grid["hc75"].idxmax())
    best_row = df_grid.iloc[best_idx]
    print(f"\n>>> BEST HC@75: thr={best_row['spread_threshold']} ste={best_row['spread_to_elo']}  "
          f"HC@75={best_row['hc75']:.3f}({int(best_row['hc75_n'])})  "
          f"Brier={best_row['brier']:.4f}")

    # Best by Brier
    bb_idx = int(df_grid["brier"].idxmin())
    bb_row = df_grid.iloc[bb_idx]
    print(f">>> BEST Brier:  thr={bb_row['spread_threshold']} ste={bb_row['spread_to_elo']}  "
          f"Brier={bb_row['brier']:.4f}  HC@75={bb_row['hc75']:.3f}({int(bb_row['hc75_n'])})")

    # Pareto: among rows with HC@75 >= 0.81 (within 1.5pp of baseline), pick lowest brier
    pareto = df_grid[df_grid["hc75"] >= 0.81].sort_values("brier")
    if len(pareto) > 0:
        pr = pareto.iloc[0]
        print(f">>> PARETO (HC@75≥0.81, min Brier): thr={pr['spread_threshold']} ste={pr['spread_to_elo']}  "
              f"HC@75={pr['hc75']:.3f}({int(pr['hc75_n'])})  Brier={pr['brier']:.4f}")

    # Save final
    final_m, df_pred = run_with(games, K, HA, Rev,
                                  float(best_row["spread_to_elo"]),
                                  float(best_row["spread_threshold"]))
    print(fmt_metrics(f"FINAL cond-spread best", final_m))
    df_pred.to_csv("data/processed/p4_predictions.csv", index=False)
    out = {"K": K, "HA": HA, "Rev": Rev,
           "spread_to_elo": float(best_row["spread_to_elo"]),
           "spread_threshold": float(best_row["spread_threshold"]),
           "composite": "OFF", "mov": "log"}
    with open("data/processed/p4_best_params.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\nFinal params:")
    print(json.dumps(out, indent=2))

    # Persist final Elo snapshot (used by predict.py)
    sys_algo_dump = EloSystem(k=K, home_adv=HA, reversion=Rev, mov_fn=mov_log,
                               spread_to_elo=float(best_row["spread_to_elo"]),
                               spread_threshold=float(best_row["spread_threshold"]))
    comp_dump = CompositeTracker(window=8)
    eval_seasons_all = list(range(1999, EVAL_END + 1))
    update_composite(sys_algo_dump, comp_dump, games, eval_seasons=eval_seasons_all,
                     use_composite=False, train_through_season=EVAL_END)
    snapshot = {
        "as_of_season": EVAL_END,
        "trained_through": "all played games through season {}".format(EVAL_END),
        "params": out,
        "ratings": dict(sys_algo_dump.ratings),
        "last_season": dict(sys_algo_dump.last_season),
    }
    with open("data/processed/p4_ratings_snapshot.json", "w") as f:
        json.dump(snapshot, f, indent=2, sort_keys=True)
    print(f"\nWrote ratings snapshot: data/processed/p4_ratings_snapshot.json  "
          f"({len(snapshot['ratings'])} teams)")


if __name__ == "__main__":
    main()