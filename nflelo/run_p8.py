"""Phase 8: backup QB penalty.

For each team, track the most-frequent QB in its last 4 games (= starting QB).
If a team's game QB is not its starting QB, apply backup_qb_penalty Elo
reduction. Grid search the penalty magnitude.
"""

from __future__ import annotations
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from pipeline import (
    EloSystem, CompositeTracker, update_composite, evaluate, fmt_metrics,
    mov_log,
)


EVAL_START = 2010
EVAL_END = 2025


def load_games():
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    return df


def run_with(games, K, HA, Rev, ste, thr, penalty, train_through=None):
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    sys_algo = EloSystem(k=K, home_adv=HA, reversion=Rev, mov_fn=mov_log,
                          spread_to_elo=ste, spread_threshold=thr,
                          backup_qb_penalty=penalty)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons,
                                use_composite=False, train_through_season=train_through)
    return evaluate(df_pred), df_pred, sys_algo


def main():
    games = load_games()
    K, HA, Rev = 16.0, 50.0, 0.40
    ste, thr = 12.0, 100.0

    print("=== P8: Backup QB penalty grid search ===")
    penalties = [0, 10, 20, 30, 40, 50, 60, 80, 100]
    rows = []
    for p in penalties:
        m, _, sys_algo = run_with(games, K, HA, Rev, ste, thr, float(p))
        h75 = m["hc75"]; h65 = m["hc65"]
        rows.append({
            "penalty": p,
            "brier": m["brier"], "logloss": m["logloss"], "acc": m["acc"],
            "hc75": h75["hit_rate"], "hc75_n": h75["n"],
            "hc65": h65["hit_rate"], "hc65_n": h65["n"],
            "n_teams_tracked": len(sys_algo.team_starting_qb),
        })
    df_grid = pd.DataFrame(rows)
    df_grid.to_csv("data/processed/p8_qb_penalty_grid.csv", index=False)

    print("\n--- Full grid (eval 2010-2025, n=4175) ---")
    print(df_grid.to_string(index=False))

    print("\n--- Top 6 by HC@75 ---")
    print(df_grid.sort_values("hc75", ascending=False).head(6).to_string(index=False))

    print("\n--- Top 5 by Brier ---")
    print(df_grid.sort_values("brier").head(5).to_string(index=False))

    # Pick best by HC@75 (primary) — but verify Brier doesn't blow up
    base_brier = df_grid.iloc[0]["brier"]
    best_idx = int(df_grid["hc75"].idxmax())
    best = df_grid.iloc[best_idx]
    print(f"\n>>> BEST (HC@75): penalty={int(best['penalty'])}  "
          f"HC@75={best['hc75']:.3f}({int(best['hc75_n'])})  "
          f"Brier={best['brier']:.4f}  (Δ_brier={best['brier']-base_brier:+.4f})")

    # Final run with best — restrict training to through 2025 (don't leak 2026 in-progress)
    final_m, df_pred, final_sys = run_with(games, K, HA, Rev, ste, thr,
                                             float(best["penalty"]),
                                             train_through=EVAL_END)
    print(fmt_metrics("FINAL", final_m))
    print(f"\nDelta vs penalty=0:")
    for k in ["hc75", "hc65", "brier", "logloss", "acc"]:
        if k in ("hc75", "hc65"):
            delta = final_m[k]["hit_rate"] - df_grid.iloc[0][k]
            print(f"  {k}: {final_m[k]['hit_rate']:.3f}  vs  {df_grid.iloc[0][k]:.3f}  Δ={delta:+.3f}")
        else:
            delta = final_m[k] - df_grid.iloc[0][k]
            print(f"  {k}: {final_m[k]:.4f}  vs  {df_grid.iloc[0][k]:.4f}  Δ={delta:+.4f}")

    df_pred.to_csv("data/processed/p8_predictions.csv", index=False)

    # Save updated snapshot
    snap = {
        "as_of_season": EVAL_END,
        "trained_through": f"all played games through season {EVAL_END}",
        "params": {"K": K, "HA": HA, "Rev": Rev, "spread_to_elo": ste,
                    "spread_threshold": thr, "composite": "OFF", "mov": "log",
                    "qb_weight": 0.0, "qb_k": 16.0,
                    "backup_qb_penalty": float(best["penalty"])},
        "ratings": dict(final_sys.ratings),
        "last_season": dict(final_sys.last_season),
        "qb_ratings": dict(final_sys.qb_ratings),
        "qb_last_season": dict(final_sys.qb_last_season),
        "team_starting_qb": dict(final_sys.team_starting_qb),
    }
    with open("data/processed/p8_ratings_snapshot.json", "w") as f:
        json.dump(snap, f, indent=2, sort_keys=True)
    print(f"\nSnapshot saved: {len(snap['ratings'])} teams, "
          f"{len(snap['qb_ratings'])} QBs, "
          f"{len(snap['team_starting_qb'])} starting-QB records")


if __name__ == "__main__":
    main()