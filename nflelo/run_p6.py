"""Phase 6: out-of-sample backtest on the new seasons (2025-2026).

Loads the P4 trained ratings snapshot (state at end-of-2024) and walks forward
through 2025-2026 WITHOUT retraining. Each prediction uses the Elo state
available BEFORE that game; the Elo is then updated with the true result so
the next prediction reflects the post-game state.

This is the cleanest out-of-sample test: no 2025/2026 information leaked
into the training ratings used for the predictions.
"""

from __future__ import annotations
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from pipeline import (
    EloSystem, CompositeTracker, update_composite, evaluate, fmt_metrics,
    mov_log,
)


# Window to evaluate (after-the-fact training cutoff = 2024)
OOS_SEASONS = [2025, 2026]


def load_games():
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    return df


def main():
    games = load_games()

    # Load P4 best params + snapshot of Elo ratings as-of end-of-2024
    with open("data/processed/p4_best_params.json") as f:
        params = json.load(f)
    with open("data/processed/p4_ratings_snapshot.json") as f:
        snap = json.load(f)
    print(f"Loaded snapshot as_of season {snap['as_of_season']}, "
          f"{len(snap['ratings'])} teams")
    print(f"Params: {params}")

    # Rebuild EloSystem from snapshot
    sys_algo = EloSystem(
        k=params["K"], home_adv=params["HA"], reversion=params["Rev"],
        mov_fn=mov_log,
        spread_to_elo=params.get("spread_to_elo", 0.0),
        spread_threshold=params.get("spread_threshold", 0.0),
    )
    sys_algo.ratings = dict(snap["ratings"])
    sys_algo.last_season = dict(snap["last_season"])

    # Walk forward through the OOS window
    oos_games = games[games["season"].isin(OOS_SEASONS)].copy()
    print(f"\nOOS games: {len(oos_games)}  "
          f"({oos_games['season'].value_counts().to_dict()})")

    rows = []
    for _, g in oos_games.iterrows():
        season = int(g["season"])
        home = g["home_team"]; away = g["away_team"]
        hs = g["home_score"]; as_ = g["away_score"]
        if pd.isna(home) or pd.isna(away):
            continue
        hs = float(hs); as_ = float(as_)
        point_diff = hs - as_
        neutral = (g.get("location") == "Neutral") if "location" in g.index else False

        # Composite OFF (P4 final config) — set to 0 explicitly
        sys_algo.composite[home] = 0.0
        sys_algo.composite[away] = 0.0

        spread_val = g.get("spread_line") if "spread_line" in g.index else None
        p_home, _ = sys_algo.predict(home, away, season=season, neutral=neutral,
                                      spread=spread_val)

        rows.append({
            "season": season,
            "week": int(g["week"]),
            "game_id": g.get("game_id"),
            "home_team": home,
            "away_team": away,
            "home_score": hs,
            "away_score": as_,
            "point_diff": point_diff,
            "pred_home": float(p_home),
            "home_win": int(point_diff > 0),
            "neutral": neutral,
        })

        # Update Elo so next prediction reflects post-game state
        winner = home if point_diff > 0 else away
        loser = away if point_diff > 0 else home
        sys_algo.update(winner, loser, abs(point_diff), season=season, neutral=neutral)

    df_pred = pd.DataFrame(rows)
    print(f"Predictions recorded: {len(df_pred)}")

    # Overall metrics
    print("\n=== OVERALL (2025 + 2026) ===")
    m = evaluate(df_pred)
    print(fmt_metrics("OOS overall", m))

    # Per-season
    print("\n=== PER-SEASON ===")
    season_rows = []
    for season, sg in df_pred.groupby("season"):
        ms = evaluate(sg)
        print(fmt_metrics(f"  season {season}", ms))
        season_rows.append({
            "season": season,
            "n": len(sg),
            "brier": ms["brier"],
            "logloss": ms["logloss"],
            "acc": ms["acc"],
            "hc75": ms["hc75"]["hit_rate"] if ms["hc75"]["n"] else None,
            "hc75_n": ms["hc75"]["n"],
            "hc65": ms["hc65"]["hit_rate"] if ms["hc65"]["n"] else None,
            "hc65_n": ms["hc65"]["n"],
        })

    # Per-week trend (regular season)
    print("\n=== REGULAR-SEASON HC@75 BY WEEK (2025) ===")
    reg = df_pred[(df_pred["season"] == 2025) & (df_pred["week"].between(1, 18))]
    if len(reg):
        weekly = []
        for wk, wg in reg.groupby("week"):
            mw = evaluate(wg)
            weekly.append({
                "week": wk,
                "n": len(wg),
                "acc": mw["acc"],
                "hc75": mw["hc75"]["hit_rate"] if mw["hc75"]["n"] else None,
                "hc75_n": mw["hc75"]["n"],
            })
        wdf = pd.DataFrame(weekly)
        print(wdf.to_string(index=False))
        # Aggregate
        print(f"\n2025 REG summary: acc={wdf['acc'].mean():.3f}  "
              f"weeks with HC@75 ≥ 70%: "
              f"{(wdf['hc75'].dropna() >= 0.7).sum()}/{wdf['hc75'].notna().sum()}")

    # Save
    out_dir = "data/processed"
    os.makedirs(out_dir, exist_ok=True)
    df_pred.to_csv(os.path.join(out_dir, "p6_oos_predictions.csv"), index=False)
    pd.DataFrame(season_rows).to_csv(os.path.join(out_dir, "p6_oos_season_metrics.csv"),
                                      index=False)
    print(f"\nWrote: {out_dir}/p6_oos_predictions.csv  ({len(df_pred)} rows)")

    # Compare against 2010-2024 baseline
    print("\n=== COMPARISON: 2025-2026 OOS vs 2010-2024 in-sample ===")
    with open("data/processed/p4_predictions.csv") as f:
        old = pd.read_csv(f)
    old_in_2010_2024 = old[old["season"].between(2010, 2024)]
    print(f"  {'window':>12}  {'N':>5}  {'Brier':>7}  {'LogLoss':>7}  {'Acc':>5}  "
          f"{'HC@75':>7}  {'n':>5}")
    for label, sub in [("2010-2024 (in-sample)", old_in_2010_2024),
                        ("2025      (OOS)", df_pred[df_pred["season"] == 2025]),
                        ("2026      (OOS)", df_pred[df_pred["season"] == 2026])]:
        if len(sub) == 0:
            continue
        ms = evaluate(sub)
        h75 = ms["hc75"]
        hr = f"{h75['hit_rate']:.3f}" if h75['hit_rate'] is not None else "  N/A"
        print(f"  {label:>22}  {len(sub):>5}  {ms['brier']:>7.4f}  {ms['logloss']:>7.4f}  "
              f"{ms['acc']:>5.3f}  {hr:>7}  {h75['n']:>5}")


if __name__ == "__main__":
    main()