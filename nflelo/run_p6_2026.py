"""2026 OOS 回测：单独看 2026 赛季开局 (week 1-2，17 场)。

起点：P7a retrain 后的 snapshot (as_of_season=2025)。
walk-forward：每场预测 → 用真实结果更新 Elo → 下一场预测。
"""

from __future__ import annotations
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from pipeline import EloSystem, evaluate, fmt_metrics, mov_log


def load_games():
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    return df


def main():
    games = load_games()
    snap_path = "data/processed/p7_ratings_snapshot.json"
    with open(snap_path) as f:
        snap = json.load(f)
    params = snap["params"]

    print(f"Snapshot: as_of_season={snap['as_of_season']}  "
          f"{len(snap['ratings'])} teams, {len(snap.get('qb_ratings', {}))} QBs")
    print(f"Params: {params}")

    sys_algo = EloSystem(
        k=params["K"], home_adv=params["HA"], reversion=params["Rev"],
        mov_fn=mov_log,
        spread_to_elo=params.get("spread_to_elo", 0.0),
        spread_threshold=params.get("spread_threshold", 0.0),
        qb_weight=params.get("qb_weight", 0.0),
        qb_k=params.get("qb_k", 20.0),
    )
    sys_algo.ratings = dict(snap["ratings"])
    sys_algo.last_season = dict(snap["last_season"])
    sys_algo.qb_ratings = dict(snap.get("qb_ratings", {}))
    sys_algo.qb_last_season = dict(snap.get("qb_last_season", {}))

    g2026 = games[games["season"] == 2026].copy()
    print(f"\n2026 completed games: {len(g2026)}\n")

    rows = []
    for _, g in g2026.iterrows():
        season = int(g["season"])
        home = g["home_team"]; away = g["away_team"]
        hs = g["home_score"]; as_ = g["away_score"]
        point_diff = float(hs) - float(as_)
        neutral = (g.get("location") == "Neutral") if "location" in g.index else False

        sys_algo.composite[home] = 0.0
        sys_algo.composite[away] = 0.0
        spread_val = g.get("spread_line")
        home_qb = g.get("home_qb_id")
        away_qb = g.get("away_qb_id")

        p_home, _ = sys_algo.predict(home, away, season=season, neutral=neutral,
                                      spread=spread_val,
                                      home_qb=home_qb, away_qb=away_qb)

        actual_home_win = int(point_diff > 0)
        pick = home if p_home >= 0.5 else away
        actual_winner = home if actual_home_win else away
        correct = (pick == actual_winner)

        rows.append({
            "week": int(g["week"]),
            "weekday": g.get("weekday"),
            "matchup": f"{away}@{home}",
            "home_team": home, "away_team": away,
            "home_score": float(hs), "away_score": float(as_),
            "point_diff": point_diff,
            "spread_line": spread_val,
            "elo_home": round(sys_algo.ratings.get(home, 1500) + (0 if neutral else params["HA"]), 1),
            "elo_away": round(sys_algo.ratings.get(away, 1500), 1),
            "pred_home": float(p_home),
            "home_win": actual_home_win,
            "pick_correct": correct,
        })

        winner = home if point_diff > 0 else away
        loser = away if point_diff > 0 else home
        winner_qb = home_qb if winner == home else away_qb
        loser_qb = away_qb if loser == away else home_qb
        sys_algo.update(winner, loser, abs(point_diff), season=season, neutral=neutral,
                         winner_qb=winner_qb, loser_qb=loser_qb)

    df_pred = pd.DataFrame(rows)
    print("=== GAME-BY-GAME ===")
    show = df_pred[["matchup", "elo_home", "elo_away", "spread_line",
                    "pred_home", "home_score", "away_score", "home_win", "pick_correct"]]
    show["pred_home_str"] = show["pred_home"].map(lambda x: f"{x:.3f}")
    print(show[["matchup", "elo_home", "elo_away", "spread_line",
                 "pred_home_str", "home_score", "away_score", "home_win",
                 "pick_correct"]].to_string(index=False))

    # Aggregate
    print("\n=== METRICS (2026 OOS, week 1-2, n=17) ===")
    m = evaluate(df_pred)
    print(fmt_metrics("2026 OOS", m))

    # Per-week
    print("\n=== PER-WEEK ===")
    for wk, sg in df_pred.groupby("week"):
        mw = evaluate(sg)
        print(fmt_metrics(f"  week {wk}", mw))

    # Calibration of spread
    print("\n=== SPREAD CALIBRATION (vs market) ===")
    print("Market spread_line ⇒ our pred")
    print(df_pred[["matchup", "spread_line", "pred_home", "home_win"]].to_string(index=False))

    # Save
    out_path = "data/processed/p6_2026_oos.csv"
    df_pred.to_csv(out_path, index=False)
    print(f"\nWrote: {out_path}")


if __name__ == "__main__":
    main()