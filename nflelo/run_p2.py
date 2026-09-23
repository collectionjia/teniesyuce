"""Phase 2 pipeline:

  Step 1  Grid search K × HA × Rev → best composite (HC@75) baseline
  Step 2  Add 4-factor composite (rolling PPG/PAPG/PD) to prediction
  Step 3  Switch MoV from ln(PD+1) → sqrt(PD)

Each step is runnable standalone (--step N) and outputs a comparison table.
"""

from __future__ import annotations
import sys, os, argparse, itertools, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import pandas as pd
from pipeline import (
    EloSystem, CompositeTracker, update_composite, evaluate,
    fmt_metrics, mov_log, mov_sqrt,
)


EVAL_START = 2010
EVAL_END = 2024  # 2026 in-progress is noisy; cap eval at 2024 for cleaner comparison


def load_games() -> pd.DataFrame:
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    return df


# ---------- Step 1: grid search -----------------------------------------------

def step1_grid(games: pd.DataFrame) -> dict:
    Ks = [16, 18, 20, 22, 24]
    HAs = [50, 65, 80, 95]
    Revs = [0.30, 0.40, 0.50]
    grid = list(itertools.product(Ks, HAs, Revs))
    print(f"\n=== Step 1: Grid search ({len(grid)} combos) ===")
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    results = []
    for i, (k, ha, rev) in enumerate(grid, 1):
        sys_algo = EloSystem(k=k, home_adv=ha, reversion=rev, mov_fn=mov_log)
        comp = CompositeTracker(window=8)
        df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons)
        m = evaluate(df_pred)
        results.append({"K": k, "HA": ha, "Rev": rev, **{
            "brier": m["brier"], "logloss": m["logloss"], "acc": m["acc"],
            "hc75": m["hc75"]["hit_rate"], "hc75_n": m["hc75"]["n"],
            "hc65": m["hc65"]["hit_rate"], "hc65_n": m["hc65"]["n"],
        }})
        if i % 10 == 0 or i == len(grid):
            print(f"  ... {i}/{len(grid)} done")
    df_res = pd.DataFrame(results)
    df_res = df_res.sort_values("hc75", ascending=False).reset_index(drop=True)
    print("\n--- TOP 10 by HC@75 ---")
    print(df_res.head(10).to_string(index=False))
    print("\n--- TOP 10 by Brier (calibration) ---")
    print(df_res.sort_values("brier").head(10).to_string(index=False))
    # Pick best by HC@75
    best = df_res.iloc[0].to_dict()
    print(f"\n>>> BEST: K={best['K']} HA={best['HA']} Rev={best['Rev']} "
          f"HC@75={best['hc75']:.3f}({int(best['hc75_n'])}) Brier={best['brier']:.4f}")
    os.makedirs("data/processed", exist_ok=True)
    df_res.to_csv("data/processed/p2_grid.csv", index=False)
    return {"K": float(best["K"]), "HA": float(best["HA"]), "Rev": float(best["Rev"])}


# ---------- Step 2: composite rating ----------------------------------------

def step2_composite(games: pd.DataFrame, base: dict) -> dict:
    print(f"\n=== Step 2: Composite rating (K={base['K']} HA={base['HA']} Rev={base['Rev']}) ===")
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    sys_algo = EloSystem(k=base["K"], home_adv=base["HA"], reversion=base["Rev"], mov_fn=mov_log)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons)
    m = evaluate(df_pred)
    print(fmt_metrics("Step2+composite", m))
    df_pred.to_csv("data/processed/p2_composite_preds.csv", index=False)
    return m


def step2_baseline_again(games: pd.DataFrame, base: dict) -> dict:
    """Re-run step 1's best params without composite, to isolate the composite effect."""
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    sys_algo = EloSystem(k=base["K"], home_adv=base["HA"], reversion=base["Rev"], mov_fn=mov_log)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons)
    # Zero out composite to isolate
    sys_algo.composite = {t: 0.0 for t in sys_algo.composite}
    # Recompute predictions without composite contribution: we need to re-run, not just mask
    # Simpler: rebuild with composite always zero
    sys_algo = EloSystem(k=base["K"], home_adv=base["HA"], reversion=base["Rev"], mov_fn=mov_log)
    # No composite updates; we still need to advance Elo + record for rolling stats?
    # Without composite, the rolling tracker has no effect; just do plain Elo walk.
    rows = []
    for _, g in games.iterrows():
        season = int(g["season"]); home = g["home_team"]; away = g["away_team"]
        hs = g["home_score"]; as_ = g["away_score"]
        if pd.isna(home) or pd.isna(away) or pd.isna(hs) or pd.isna(as_):
            continue
        hs = float(hs); as_ = float(as_)
        point_diff = hs - as_
        neutral = (g.get("location") == "Neutral") if "location" in g.index else False
        p_home, _ = sys_algo.predict(home, away, season=season, neutral=neutral)
        if eval_seasons[0] <= season <= eval_seasons[-1]:
            rows.append({"pred_home": float(p_home), "home_win": int(point_diff > 0)})
        winner = home if point_diff > 0 else away
        loser = away if point_diff > 0 else home
        sys_algo.update(winner, loser, abs(point_diff), season=season, neutral=neutral)
    m = evaluate(pd.DataFrame(rows))
    print(fmt_metrics("Step2(no comp)", m))
    return m


# ---------- Step 3: MoV sqrt --------------------------------------------------

def step3_mov(games: pd.DataFrame, base: dict) -> dict:
    print(f"\n=== Step 3: MoV sqrt variant (K={base['K']} HA={base['HA']} Rev={base['Rev']}) ===")
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    sys_algo = EloSystem(k=base["K"], home_adv=base["HA"], reversion=base["Rev"], mov_fn=mov_sqrt)
    comp = CompositeTracker(window=8)
    df_pred = update_composite(sys_algo, comp, games, eval_seasons=eval_seasons)
    m = evaluate(df_pred)
    print(fmt_metrics("Step3 sqrt MoV", m))
    df_pred.to_csv("data/processed/p2_sqrt_mov_preds.csv", index=False)
    return m


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", type=int, default=0,
                        help="0 = all steps, 1/2/3 = single step")
    parser.add_argument("--K", type=float, default=None)
    parser.add_argument("--HA", type=float, default=None)
    parser.add_argument("--Rev", type=float, default=None)
    args = parser.parse_args()

    games = load_games()
    print(f"Loaded {len(games)} games  seasons {games['season'].min()}-{games['season'].max()}")
    print(f"Eval window: {EVAL_START}-{EVAL_END} ({(games['season'].between(EVAL_START, EVAL_END)).sum()} games)")

    if args.step in (0, 1):
        best = step1_grid(games)
        if args.K: best["K"] = args.K
        if args.HA: best["HA"] = args.HA
        if args.Rev: best["Rev"] = args.Rev
        with open("data/processed/p2_best_params.json", "w") as f:
            json.dump(best, f, indent=2)
    else:
        with open("data/processed/p2_best_params.json") as f:
            best = json.load(f)
        if args.K: best["K"] = args.K
        if args.HA: best["HA"] = args.HA
        if args.Rev: best["Rev"] = args.Rev

    if args.step in (0, 2):
        m_no_comp = step2_baseline_again(games, best)
        m_comp = step2_composite(games, best)
        print("\n--- Step 2 Δ (composite - baseline) ---")
        for k in ["hc75", "hc65", "brier", "logloss", "acc"]:
            if k in ("hc75", "hc65"):
                print(f"  {k}: {m_comp[k]['hit_rate']:.3f}  vs  {m_no_comp[k]['hit_rate']:.3f}  "
                      f"= {(m_comp[k]['hit_rate'] - m_no_comp[k]['hit_rate']):+.3f}")
            else:
                print(f"  {k}: {m_comp[k]:.4f}  vs  {m_no_comp[k]:.4f}  "
                      f"= {(m_comp[k] - m_no_comp[k]):+.4f}")

    if args.step in (0, 3):
        m_sqrt = step3_mov(games, best)
        print(f"\n>>> Step 3 result: HC@75={m_sqrt['hc75']['hit_rate']:.3f}({m_sqrt['hc75']['n']})  "
              f"Brier={m_sqrt['brier']:.4f}")

    print("\nFinal best params:")
    print(json.dumps(best, indent=2))


if __name__ == "__main__":
    main()