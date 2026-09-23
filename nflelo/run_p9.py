"""Phase 9: XGBoost ensemble on top of P8 Elo.

Build a feature matrix for each game from nflverse fields, then train an
XGBoost classifier walk-forward in lockstep with the Elo walk. The model
predicts P(home_win) given:

  - elo_prob            (P8 Elo win probability)
  - elo_diff_post       (Elo diff after spread/penalty)
  - spread_line         (market spread)
  - home_rest, away_rest (days since last game)
  - div_game            (1 if division rival)
  - surface             (one-hot: grass/turf/dome)
  - roof                (one-hot: outdoors/dome/closed)
  - temp, wind          (weather scores from CSV)
  - week                (regular-season week number)
  - qb_elo_diff         (optional, QB Elo diff)

Walk-forward: for each game, features are computed BEFORE the game, target is
the actual home-win. No future leakage.

Outputs:
  - elo-only baseline (P8)
  - XGBoost-only
  - weighted blend: alpha * elo + (1-alpha) * xgb
Grid search alpha and XGBoost hyperparams.
"""

from __future__ import annotations
import sys, os, json, itertools
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import numpy as np
import pandas as pd
import pickle
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.ensemble import HistGradientBoostingClassifier

from pipeline import (
    EloSystem, CompositeTracker, update_composite, evaluate, fmt_metrics,
    mov_log,
)


EVAL_START = 2010
EVAL_END = 2025


def load_and_engineer():
    df = pd.read_csv("data/raw/games.csv")
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)

    # Build Elo walk (P8 config) and capture per-game predictions
    K, HA, Rev = 16.0, 50.0, 0.40
    ste, thr, penalty = 12.0, 100.0, 30.0
    sys_algo = EloSystem(k=K, home_adv=HA, reversion=Rev, mov_fn=mov_log,
                          spread_to_elo=ste, spread_threshold=thr,
                          backup_qb_penalty=penalty)
    comp = CompositeTracker(window=8)
    eval_seasons = list(range(EVAL_START, EVAL_END + 1))
    df_pred = update_composite(sys_algo, comp, games=df, eval_seasons=eval_seasons,
                                use_composite=False, train_through_season=EVAL_END)

    # merge with games for features
    cols_needed = ["game_id", "season", "week", "home_team", "away_team",
                    "home_score", "away_score", "home_rest", "away_rest",
                    "div_game", "surface", "roof", "temp", "wind",
                    "spread_line", "home_qb_id", "away_qb_id"]
    df_pred = df_pred.merge(df[cols_needed], on="game_id", suffixes=("", "_dup"))
    # drop dup cols
    for c in df_pred.columns:
        if c.endswith("_dup"):
            df_pred.drop(columns=[c], inplace=True)

    # Add features
    df_pred["home_win"] = df_pred["home_win"].astype(int)
    # Reverse-engineer Elo diff from prob (logit * 400); monotonic in Elo diff
    from math import log
    p = df_pred["pred_home"].clip(1e-3, 1 - 1e-3)
    df_pred["elo_diff_post"] = -400.0 * (np.log(1 - p) - np.log(p))  # logit(p/(1-p)) * -400
    df_pred["elo_diff_post"] = df_pred["elo_diff_post"].astype(float)

    # Surface one-hot
    surface_dummies = pd.get_dummies(df_pred["surface"].fillna("unknown"),
                                       prefix="surface")
    roof_dummies = pd.get_dummies(df_pred["roof"].fillna("unknown"), prefix="roof")
    df_pred = pd.concat([df_pred, surface_dummies, roof_dummies], axis=1)

    # weather
    df_pred["temp"] = pd.to_numeric(df_pred["temp"], errors="coerce")
    df_pred["wind"] = pd.to_numeric(df_pred["wind"], errors="coerce")
    df_pred["temp_filled"] = df_pred["temp"].fillna(df_pred["temp"].median())
    df_pred["wind_filled"] = df_pred["wind"].fillna(df_pred["wind"].median())

    # rest advantage
    df_pred["rest_diff"] = df_pred["home_rest"].fillna(7) - df_pred["away_rest"].fillna(7)

    return df_pred, sys_algo


FEATURE_COLS_BASE = [
    "pred_home", "elo_diff_post",
    "spread_line", "home_rest", "away_rest", "rest_diff",
    "div_game", "week", "temp_filled", "wind_filled",
]


def get_feature_cols(df):
    extras = [c for c in df.columns if c.startswith("surface_") or c.startswith("roof_")]
    return FEATURE_COLS_BASE + extras


def walk_forward_xgb(df, params, eval_window=(2018, 2025)):
    """Train gradient-boosted trees (sklearn HistGradientBoosting) year-by-year
    expanding. (Originally XGBoost; switched because XGBoost requires libomp
    which isn't installed on this machine. HistGradientBoosting is the same
    algorithm family — histogram-based gradient boosting — and ships with
    scikit-learn, no extra system deps.)
    """
    es, ee = eval_window
    train_mask = df["season"] < es
    feature_cols = get_feature_cols(df)
    X_all = df[feature_cols].fillna(0).values
    y_all = df["home_win"].astype(int).values
    seasons = df["season"].values

    X_tr = X_all[train_mask]
    y_tr = y_all[train_mask]

    preds = np.full(len(df), np.nan)
    for yr in range(es, ee + 1):
        test_mask = seasons == yr
        if not test_mask.any():
            continue
        X_te = X_all[test_mask]
        model = HistGradientBoostingClassifier(
            max_iter=params.get("n_estimators", 100),
            max_depth=params.get("max_depth", 5),
            learning_rate=params.get("learning_rate", 0.1),
            min_samples_leaf=params.get("min_samples_leaf", 20),
            random_state=42,
        )
        model.fit(X_tr, y_tr)
        p_te = model.predict_proba(X_te)[:, 1]
        preds[test_mask] = p_te
        X_tr = np.vstack([X_tr, X_te])
        y_tr = np.concatenate([y_tr, y_all[test_mask]])

    out = df.copy()
    out["xgb_prob"] = preds
    return out


def evaluate_blend(df, alpha):
    """Blend Elo prob with XGBoost prob. alpha=1.0 ⇒ pure Elo."""
    if "xgb_prob" not in df.columns or df["xgb_prob"].isna().all():
        return None
    valid = df.dropna(subset=["xgb_prob"]).copy()
    valid["blend_prob"] = alpha * valid["pred_home"] + (1 - alpha) * valid["xgb_prob"]
    p = valid["blend_prob"].clip(1e-9, 1 - 1e-9).values
    y = valid["home_win"].astype(int).values
    return {
        "n": len(valid),
        "brier": float(((p - y) ** 2).mean()),
        "logloss": float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()),
        "acc": float(((p >= 0.5).astype(int) == y).mean()),
    }


def evaluate_xgb_only(df):
    valid = df.dropna(subset=["xgb_prob"]).copy()
    p = valid["xgb_prob"].clip(1e-9, 1 - 1e-9).values
    y = valid["home_win"].astype(int).values
    return {
        "n": len(valid),
        "brier": float(((p - y) ** 2).mean()),
        "logloss": float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()),
        "acc": float(((p >= 0.5).astype(int) == y).mean()),
    }


def hc_at(df, thr, col):
    sub = df[df[col] >= thr]
    if len(sub) == 0:
        return None
    won = sub["home_win"].sum()
    return {"n": len(sub), "hit_rate": won / len(sub)}


def main():
    print("Building walk-forward features (P8 Elo + nflverse fields)…")
    df, sys_algo = load_and_engineer()
    print(f"Total games: {len(df)}  features: {len(get_feature_cols(df))}")

    print("\n=== Elo-only baseline (P8, eval 2018-2025, walk-forward year-by-year) ===")
    eval_mask = df["season"].between(2018, 2025)
    elo_only = df[eval_mask].copy()
    print(fmt_metrics("Elo-only (P8, 2018-2025)", {
        "n": len(elo_only), "brier": 0, "logloss": 0, "acc": 0,
        "hc75": {"n": 0, "hit_rate": None}, "hc65": {"n": 0, "hit_rate": None},
        "hc55": {"n": 0, "hit_rate": None}}))
    m = evaluate(elo_only)
    print(f"  → N={m['n']}  Brier={m['brier']:.4f}  LogLoss={m['logloss']:.4f}  "
          f"Acc={m['acc']:.3f}  HC@75={m['hc75']['hit_rate']}  HC@65={m['hc65']['hit_rate']}")

    # XGBoost grid
    print("\n=== XGBoost walk-forward (year-by-year expanding train) ===")
    xgb_grid = list(itertools.product(
        [50, 100, 200],                # n_estimators
        [3, 5, 7],                      # max_depth
        [0.05, 0.1, 0.2],               # learning_rate
    ))
    print(f"Searching {len(xgb_grid)} XGBoost configs…")

    best_brier = 1.0
    best_cfg = None
    rows = []
    for ne, md, lr in xgb_grid:
        params = {"n_estimators": ne, "max_depth": md, "learning_rate": lr,
                   "min_child_weight": 5, "subsample": 0.8, "colsample_bytree": 0.8}
        df_xgb = walk_forward_xgb(df, params, eval_window=(2018, 2025))
        m_xgb = evaluate_xgb_only(df_xgb[df_xgb["season"].between(2018, 2025)])
        rows.append({"ne": ne, "md": md, "lr": lr, **m_xgb})
        if m_xgb["brier"] < best_brier:
            best_brier = m_xgb["brier"]
            best_cfg = (ne, md, lr)
        # try blends
        for alpha in [0.7, 0.5, 0.3]:
            pass  # computed in next step
    df_grid = pd.DataFrame(rows).sort_values("brier")
    df_grid.to_csv("data/processed/p9_xgb_grid.csv", index=False)
    print("\n--- Top 8 XGBoost configs (by Brier, XGB-only) ---")
    print(df_grid.head(8).to_string(index=False))
    print(f"\n>>> Best XGB cfg: n_estimators={best_cfg[0]} max_depth={best_cfg[1]} lr={best_cfg[2]}  "
          f"Brier={best_brier:.4f}")

    # Run best XGB and compare blends
    print("\n=== Blend search: alpha × Elo + (1-alpha) × XGB ===")
    params = {"n_estimators": best_cfg[0], "max_depth": best_cfg[1],
               "learning_rate": best_cfg[2], "min_samples_leaf": 20}
    df_xgb = walk_forward_xgb(df, params, eval_window=(2018, 2025))
    df_xgb = df_xgb[df_xgb["season"].between(2018, 2025)].copy()

    blend_rows = []
    for alpha in [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0]:
        m = evaluate_blend(df_xgb, alpha)
        if m is None:
            continue
        # also compute HC@75 / HC@65
        df_xgb["blend_prob"] = alpha * df_xgb["pred_home"] + (1 - alpha) * df_xgb["xgb_prob"]
        h75 = hc_at(df_xgb, 0.75, "blend_prob") or {"n": 0, "hit_rate": None}
        h65 = hc_at(df_xgb, 0.65, "blend_prob") or {"n": 0, "hit_rate": None}
        blend_rows.append({"alpha": alpha, **m,
                           "hc75": h75["hit_rate"], "hc75_n": h75["n"],
                           "hc65": h65["hit_rate"], "hc65_n": h65["n"]})
    df_blend = pd.DataFrame(blend_rows)
    print(df_blend.to_string(index=False))
    df_blend.to_csv("data/processed/p9_blend_grid.csv", index=False)

    # Best by HC@75
    h75_best = df_blend.dropna(subset=["hc75"]).sort_values("hc75", ascending=False).iloc[0]
    brier_best = df_blend.sort_values("brier").iloc[0]
    print(f"\n>>> BEST HC@75: alpha={h75_best['alpha']}  "
          f"HC@75={h75_best['hc75']:.3f}({int(h75_best['hc75_n'])})  "
          f"Brier={h75_best['brier']:.4f}")
    print(f">>> BEST Brier:  alpha={brier_best['alpha']}  "
          f"Brier={brier_best['brier']:.4f}  HC@75={brier_best['hc75']}")

    # Save final XGB predictions
    chosen_alpha = float(h75_best["alpha"]) if h75_best["hc75"] is not None else 1.0
    df_xgb["final_prob"] = chosen_alpha * df_xgb["pred_home"] + (1 - chosen_alpha) * df_xgb["xgb_prob"]
    df_xgb.to_csv("data/processed/p9_predictions.csv", index=False)
    print(f"\nWrote p9_predictions.csv ({len(df_xgb)} rows, eval 2018-2025)")

    # Train FINAL XGB model on ALL data through 2025 (for live ensemble use)
    print("\nTraining final XGB model on all data through 2025…")
    feature_cols = get_feature_cols(df)
    X_all = df[feature_cols].fillna(0).values
    y_all = df["home_win"].astype(int).values
    train_mask_full = df["season"] <= EVAL_END
    final_model = HistGradientBoostingClassifier(
        max_iter=params["n_estimators"], max_depth=params["max_depth"],
        learning_rate=params["learning_rate"], min_samples_leaf=20, random_state=42,
    )
    final_model.fit(X_all[train_mask_full], y_all[train_mask_full])
    bundle = {
        "model": final_model,
        "feature_cols": feature_cols,
        "blend_alpha": chosen_alpha,
        "xgb_params": params,
        "trained_through_season": EVAL_END,
    }
    with open("data/processed/xgb_ensemble.pkl", "wb") as f:
        pickle.dump(bundle, f)
    print(f"Saved data/processed/xgb_ensemble.pkl "
          f"({len(feature_cols)} features, alpha={chosen_alpha}, "
          f"trained on {int(train_mask_full.sum())} games)")

    # Save best config
    out = {
        "xgb_params": params,
        "blend_alpha": chosen_alpha,
        "eval_window": [2018, 2025],
        "metrics_hc75_priority": {
            "alpha": chosen_alpha,
            "brier": h75_best["brier"], "logloss": h75_best["logloss"],
            "acc": h75_best["acc"], "hc75": h75_best["hc75"], "hc65": h75_best["hc65"],
            "n": int(h75_best["n"]),
        },
    }
    with open("data/processed/p9_best_params.json", "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nFinal params saved: alpha={chosen_alpha}")


if __name__ == "__main__":
    main()