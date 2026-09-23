"""Phase 7: QB Elo sub-system + retrain through 2025.

Adds a per-QB Elo rating that adjusts the team-level Elo prediction. Grid
searches qb_weight (how much QB Elo contributes to prediction) × qb_k
(K-factor for QB Elo updates).

After P7a, the snapshot is updated to reflect training through season 2025.
P7b layers QB Elo on top and writes a new best-params snapshot if it improves
HC@75 / Brier.
"""

from __future__ import annotations
import sys, os, json, itertools
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from pipeline import (
    EloSystem, CompositeTracker, update_composite, evaluate, fmt_metrics,
    mov_log, START_ELO,
)


EVAL_START = 2010
EVAL_END = 2025  # retrain window — includes 2025


def load_games():
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    return df


def run_with(games, K, HA, Rev, ste, thr, qb_w, qb_k):
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    sys_algo = EloSystem(k=K, home_adv=HA, reversion=Rev, mov_fn=mov_log,
                          spread_to_elo=ste, spread_threshold=thr,
                          qb_weight=qb_w, qb_k=qb_k)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons,
                                use_composite=False)
    return evaluate(df_pred), df_pred, sys_algo


def main():
    games = load_games()

    K, HA, Rev = 16.0, 50.0, 0.40
    ste, thr = 12.0, 100.0

    print("=== P7a: retrain through 2025 (no QB Elo) ===")
    base_m, _, base_sys = run_with(games, K, HA, Rev, ste, thr, 0.0, 20.0)
    print(fmt_metrics("P7a baseline", base_m))

    # Save P7a snapshot (no QB)
    snap_a = {
        "as_of_season": EVAL_END,
        "trained_through": f"all played games through season {EVAL_END}",
        "params": {"K": K, "HA": HA, "Rev": Rev, "spread_to_elo": ste,
                    "spread_threshold": thr, "composite": "OFF", "mov": "log",
                    "qb_weight": 0.0, "qb_k": 0.0},
        "ratings": dict(base_sys.ratings),
        "last_season": dict(base_sys.last_season),
    }
    with open("data/processed/p7a_ratings_snapshot.json", "w") as f:
        json.dump(snap_a, f, indent=2, sort_keys=True)
    print(f"Snapshot saved (no QB): {len(snap_a['ratings'])} teams")

    print("\n=== P7b: QB Elo grid search ===")
    qb_weights = [0.0, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]
    qb_ks = [16, 20, 24, 32]
    grid = list(itertools.product(qb_weights, qb_ks))
    print(f"Searching {len(grid)} combinations…")
    rows = []
    for i, (w, k) in enumerate(grid, 1):
        m, _, _ = run_with(games, K, HA, Rev, ste, thr, float(w), float(k))
        h75 = m["hc75"]; h65 = m["hc65"]
        rows.append({
            "qb_weight": w, "qb_k": k,
            "brier": m["brier"], "logloss": m["logloss"], "acc": m["acc"],
            "hc75": h75["hit_rate"], "hc75_n": h75["n"],
            "hc65": h65["hit_rate"], "hc65_n": h65["n"],
        })
        if i % 8 == 0 or i == len(grid):
            print(f"  ... {i}/{len(grid)} done")
    df_grid = pd.DataFrame(rows)
    df_grid.to_csv("data/processed/p7_qb_grid.csv", index=False)

    print("\n--- Top 12 by HC@75 ---")
    print(df_grid.sort_values("hc75", ascending=False).head(12).to_string(index=False))
    print("\n--- Top 8 by Brier ---")
    print(df_grid.sort_values("brier").head(8).to_string(index=False))

    # Don't auto-pick best — surface trade-off, let user choose.
    # Show full grid for HC@75 + Brier analysis.
    print("\n=== TRADE-OFF: HC@75 vs Brier ===")
    print("qb_weight  qb_k     brier  Δ_brier    hc75  Δ_hc75  hc75_n  Δ_n")
    base_brier = df_grid.iloc[0]["brier"]
    base_hc75 = df_grid.iloc[0]["hc75"]
    base_n = df_grid.iloc[0]["hc75_n"]
    for _, r in df_grid.iterrows():
        if r["qb_weight"] in (0.0, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50):
            print(f"  {r['qb_weight']:>4.2f}      {int(r['qb_k']):>3}  "
                  f"{r['brier']:.4f}  {r['brier']-base_brier:+.4f}  "
                  f"{r['hc75']:.3f}  {r['hc75']-base_hc75:+.3f}  "
                  f"{int(r['hc75_n']):>4}  {int(r['hc75_n'])-int(base_n):+4}")

    # Recommend: HC@75 priority → qb_weight=0 (no QB)
    # Brier priority → qb_weight=0.15, qb_k=16 (best Brier)
    best_brier = df_grid.sort_values("brier").iloc[0]
    print(f"\n>>> HC@75 PRIORITY (gold metric): qb_weight=0.0  HC@75={base_hc75:.3f}({int(base_n)})")
    print(f">>> Brier PRIORITY:                qb_weight={best_brier['qb_weight']} qb_k={int(best_brier['qb_k'])}  "
          f"Brier={best_brier['brier']:.4f}  HC@75={best_brier['hc75']:.3f}")

    # Default final: HC@75 priority (no QB)
    chosen_w = 0.0
    chosen_k = float(best_brier["qb_k"])  # keep QB Elo data in snapshot
    print(f"\n>>> DEFAULT FINAL CONFIG: qb_weight={chosen_w} (HC@75 priority)")

    final_m, df_pred, final_sys = run_with(games, K, HA, Rev, ste, thr,
                                             chosen_w, chosen_k)
    print(fmt_metrics("FINAL", final_m))
    df_pred.to_csv("data/processed/p7_qb_predictions.csv", index=False)

    # Get QB ratings by walking once with qb_weight > 0 (for snapshot only)
    print("\nBuilding QB Elo snapshot (one walk with qb_weight=0.15)…")
    _, _, qb_sys = run_with(games, K, HA, Rev, ste, thr,
                             float(best_brier["qb_weight"]), float(best_brier["qb_k"]))
    qb_ratings = dict(qb_sys.qb_ratings)
    qb_last_season = dict(qb_sys.qb_last_season)

    # Snapshot: team ratings from final_sys (no QB), but QB ratings included for flipping later
    snap_b = {
        "as_of_season": EVAL_END,
        "trained_through": f"all played games through season {EVAL_END}",
        "params": {"K": K, "HA": HA, "Rev": Rev, "spread_to_elo": ste,
                    "spread_threshold": thr, "composite": "OFF", "mov": "log",
                    "qb_weight": 0.0, "qb_k": float(best_brier["qb_k"])},
        "ratings": dict(final_sys.ratings),
        "last_season": dict(final_sys.last_season),
        "qb_ratings": qb_ratings,
        "qb_last_season": qb_last_season,
    }
    with open("data/processed/p7_ratings_snapshot.json", "w") as f:
        json.dump(snap_b, f, indent=2, sort_keys=True)
    print(f"\nFinal snapshot: {len(snap_b['ratings'])} teams, "
          f"{len(snap_b['qb_ratings'])} QBs (qb_weight=0 by default; "
          f"flip to {best_brier['qb_weight']} to enable)")

    # Top QB Elo
    print("\n--- Top 10 QBs by Elo (snapshot data, weight=0 by default) ---")
    qb_items = sorted(snap_b["qb_ratings"].items(), key=lambda kv: -kv[1])
    for qid, elo in qb_items[:10]:
        ls = snap_b["qb_last_season"].get(qid)
        print(f"  {qid}: {elo:.0f}  (last: {ls})")


if __name__ == "__main__":
    main()