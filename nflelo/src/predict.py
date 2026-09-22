"""Public prediction interface for the NFL Elo model.

Loads the trained snapshot written by run_p8.py and exposes predict(...).

Usage:
    from predict import predict, team_ratings
    print(predict("KC", "BUF", neutral=False))
    print(team_ratings().head(10))

The model uses P8 best params (K=16, HA=50, Rev=0.4, spread_to_elo=12,
spread_threshold=100, composite=OFF, backup_qb_penalty=30).
"""

from __future__ import annotations
import json
import math
import os
from typing import Iterable

import numpy as np

# Default snapshot path (relative to repo root)
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SNAPSHOT = os.path.join(_REPO_ROOT, "data/processed/p8_ratings_snapshot.json")
DEFAULT_PARAMS = os.path.join(_REPO_ROOT, "data/processed/p4_best_params.json")


def _load(snapshot_path: str):
    with open(snapshot_path) as f:
        snap = json.load(f)
    return snap


def _expected_score(elo_a: float, elo_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((elo_b - elo_a) / 400.0))


def _expected_margin(elo_diff: float, c: float = 0.026) -> float:
    """FiveThirtyEight-style: 1 Elo ≈ c points of expected margin.
    Roughly 38 Elo ≈ 1 point."""
    return elo_diff * c


def _load_xgb_ensemble(path: str = None):
    """Load XGBoost ensemble bundle (trained by run_p9.py). Returns None if unavailable."""
    import os
    if path is None:
        path = os.path.join(_REPO_ROOT, "data/processed/xgb_ensemble.pkl")
    if not os.path.exists(path):
        return None
    import pickle
    with open(path, "rb") as f:
        return pickle.load(f)


def _xgb_predict_prob(bundle: dict, team_a: str, team_b: str, neutral: bool,
                       spread: float | None, season: int | None,
                       home_qb: str | None, away_qb: str | None,
                       pred_home_elo: float) -> float | None:
    """Build a feature vector matching the XGBoost bundle's training features
    and return P(home_win). Requires nflverse CSV to look up game-level fields.
    For live single-game prediction we use the team's most recent game for rest,
    surface, temp, etc. — falls back to neutral defaults if missing.
    """
    import os, pandas as pd
    raw_path = os.path.join(_REPO_ROOT, "data/raw/games.csv")
    if not os.path.exists(raw_path):
        return None
    df = pd.read_csv(raw_path)
    df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    # Find most recent game for team_a (home) and team_b (away)
    feat_cols = bundle["feature_cols"]
    # Build feature row
    ha_rec = df[(df["home_team"] == team_a) | (df["away_team"] == team_a)].sort_values(
        ["season", "week"]).tail(1).iloc[0] if (df["home_team"] == team_a).any() or (df["away_team"] == team_a).any() else None
    rest_a = float(ha_rec["home_rest"]) if ha_rec is not None and not pd.isna(ha_rec.get("home_rest")) else 7.0
    ab_rec = df[(df["home_team"] == team_b) | (df["away_team"] == team_b)].sort_values(
        ["season", "week"]).tail(1).iloc[0] if (df["home_team"] == team_b).any() or (df["away_team"] == team_b).any() else None
    rest_b = float(ab_rec["away_rest"]) if ab_rec is not None and not pd.isna(ab_rec.get("away_rest")) else 7.0
    surface = str(ha_rec.get("surface") or "unknown") if ha_rec is not None else "unknown"
    roof = str(ha_rec.get("roof") or "unknown") if ha_rec is not None else "unknown"
    div_game = 1 if (ha_rec is not None and ha_rec.get("div_game") == 1) else 0
    week = int(ha_rec["week"]) if ha_rec is not None and not pd.isna(ha_rec.get("week")) else 1
    temp = float(ha_rec["temp"]) if ha_rec is not None and not pd.isna(ha_rec.get("temp")) else 65.0
    wind = float(ha_rec["wind"]) if ha_rec is not None and not pd.isna(ha_rec.get("wind")) else 8.0

    row = {
        "pred_home": float(pred_home_elo),
        "elo_diff_post": -400.0 * (np.log(max(min(pred_home_elo, 1-1e-3), 1e-3) /
                                         (1 - max(min(pred_home_elo, 1-1e-3), 1e-3)))),
        "spread_line": float(spread) if spread is not None else 0.0,
        "home_rest": rest_a, "away_rest": rest_b, "rest_diff": rest_a - rest_b,
        "div_game": div_game, "week": week, "temp_filled": temp, "wind_filled": wind,
    }
    for col in feat_cols:
        if col.startswith("surface_"):
            row[col] = 1.0 if surface == col.replace("surface_", "") else 0.0
        elif col.startswith("roof_"):
            row[col] = 1.0 if roof == col.replace("roof_", "") else 0.0
    # Reindex in bundle order
    X = pd.DataFrame([row]).reindex(columns=feat_cols, fill_value=0)
    prob = bundle["model"].predict_proba(X.values)[:, 1][0]
    return float(prob)


def predict(
    team_a: str,
    team_b: str,
    neutral: bool = False,
    spread: float | None = None,
    season: int | None = None,
    home_qb: str | None = None,
    away_qb: str | None = None,
    use_xgb_ensemble: bool = True,
    snapshot_path: str = DEFAULT_SNAPSHOT,
) -> dict:
    """Predict a single game's win probabilities and expected margin.

    If use_xgb_ensemble=True AND data/processed/xgb_ensemble.pkl exists,
    blends the Elo prob with XGBoost (60% Elo + 40% XGBoost by default).
    Falls back to pure Elo if XGBoost bundle unavailable.

    Args:
        team_a: home team's abbreviation (e.g. "KC")
        team_b: away team's abbreviation (e.g. "BUF")
        neutral: True for neutral-site games (Super Bowl, etc.)
        spread: pre-game market spread (home_perspective, +ve ⇒ home favored).
                If provided AND |elo_diff| < params.spread_threshold, the spread
                contributes. Otherwise it is ignored.
        season: if given, apply mean-reversion for new-season teams.
        home_qb / away_qb: optional QB ids. If the team's QB differs from its
                declared starting QB, backup_qb_penalty is applied.
        snapshot_path: override path to the trained ratings JSON.

    Returns:
        dict with keys:
          - team_a, team_b
          - win_prob_a, win_prob_b
          - win_prob_a_elo_only (always present; equals win_prob_a when XGB off)
          - xgb_blend_used
          - elo_a, elo_b (raw, before home-adv/spread add)
          - elo_a, elo_b (raw, before home-adv/spread add)
          - elo_diff_after_spread (the working diff used to compute prob)
          - spread_used (bool), spread_value (float|None)
          - backup_penalty_applied (bool)
          - expected_margin_a (positive ⇒ A expected to win by that many)
          - confidence_tier ("high" if prob >= .75, "medium" if >= .65, else "low")
    """
    snap = _load(snapshot_path)
    params = snap["params"]
    ratings: dict[str, float] = dict(snap["ratings"])
    last_season: dict[str, int] = dict(snap.get("last_season", {}))
    starting_qb: dict[str, str] = dict(snap.get("team_starting_qb", {}))
    start_elo = params.get("start_elo", 1500.0)
    backup_penalty = params.get("backup_qb_penalty", 0.0)
    rev = params.get("Rev", params.get("reversion", 0.40))

    team_a = team_a.upper()
    team_b = team_b.upper()

    def get(team):
        r = ratings.get(team, start_elo)
        ls = last_season.get(team)
        if season is not None and ls is not None and ls != season:
            r = r + (start_elo - r) * rev
        return r

    elo_a = get(team_a)
    elo_b = get(team_b)

    # Home advantage goes to team_a (treated as home) unless neutral
    ha = 0.0 if neutral else params["HA"]
    elo_a_for_pred = elo_a + ha
    elo_b_for_pred = elo_b

    # Backup QB penalty (P8 feature)
    backup_applied = False
    if backup_penalty > 0:
        starter_a = starting_qb.get(team_a)
        starter_b = starting_qb.get(team_b)
        if home_qb is not None and starter_a is not None and home_qb != starter_a:
            elo_a_for_pred -= backup_penalty
            backup_applied = True
        if away_qb is not None and starter_b is not None and away_qb != starter_b:
            elo_b_for_pred -= backup_penalty
            backup_applied = True

    # Conditional spread (P4 feature)
    spread_used = False
    spread_value = spread
    ste = params.get("spread_to_elo", 0.0)
    thr = params.get("spread_threshold", 0.0)
    if spread is not None and ste > 0 and (thr <= 0 or abs(elo_a_for_pred - elo_b_for_pred) < thr):
        elo_a_for_pred += spread * ste
        spread_used = True

    p_a_elo = _expected_score(elo_a_for_pred, elo_b_for_pred)
    p_a = p_a_elo
    blend_used = False
    if use_xgb_ensemble:
        bundle = _load_xgb_ensemble()
        if bundle is not None:
            try:
                p_xgb = _xgb_predict_prob(bundle, team_a, team_b, neutral,
                                            spread, season, home_qb, away_qb,
                                            pred_home_elo=p_a_elo)
                if p_xgb is not None:
                    alpha = bundle.get("blend_alpha", 0.6)
                    p_a = alpha * p_a_elo + (1 - alpha) * p_xgb
                    blend_used = True
            except Exception as e:
                # If XGBoost feature build fails (e.g. team not in CSV), fall back silently
                p_a = p_a_elo

    p_b = 1.0 - p_a
    diff = elo_a_for_pred - elo_b_for_pred
    exp_margin = _expected_margin(diff)

    if p_a >= 0.75:
        tier = "high"
    elif p_a >= 0.65:
        tier = "medium"
    elif p_a <= 0.25:
        tier = f"high({team_b})"
    elif p_a <= 0.35:
        tier = f"medium({team_b})"
    else:
        tier = "low"

    return {
        "team_a": team_a,
        "team_b": team_b,
        "neutral": bool(neutral),
        "win_prob_a": round(p_a, 4),
        "win_prob_b": round(p_b, 4),
        "win_prob_a_elo_only": round(p_a_elo, 4),
        "xgb_blend_used": blend_used,
        "elo_a": round(elo_a, 1),
        "elo_b": round(elo_b, 1),
        "elo_diff_after_spread": round(diff, 1),
        "spread_used": spread_used,
        "spread_value": spread_value,
        "backup_penalty_applied": backup_applied,
        "expected_margin_a": round(exp_margin, 2),
        "confidence_tier": tier,
    }


def predict_games(pairs: Iterable[tuple[str, str]], neutral: bool = False,
                   spreads: dict[tuple[str, str], float] | None = None,
                   qbs: dict[tuple[str, str], tuple[str | None, str | None]] | None = None,
                   season: int | None = None,
                   snapshot_path: str = DEFAULT_SNAPSHOT) -> list[dict]:
    """Batch prediction. spreads is {(a,b): spread_value}; qbs is {(a,b): (home_qb, away_qb)}."""
    spreads = spreads or {}
    qbs = qbs or {}
    out = []
    for (a, b) in pairs:
        home_qb, away_qb = qbs.get((a, b), (None, None))
        out.append(predict(a, b, neutral=neutral, spread=spreads.get((a, b)),
                            season=season, home_qb=home_qb, away_qb=away_qb,
                            snapshot_path=snapshot_path))
    return out


def team_ratings(snapshot_path: str = DEFAULT_SNAPSHOT) -> "pd.DataFrame":
    """Return current Elo ratings as a DataFrame sorted descending."""
    import pandas as pd
    snap = _load(snapshot_path)
    starting_qb = snap.get("team_starting_qb", {})
    rows = [{"team": t, "elo": round(r, 1),
             "last_season": snap.get("last_season", {}).get(t),
             "starting_qb": starting_qb.get(t)}
            for t, r in snap["ratings"].items()]
    df = pd.DataFrame(rows).sort_values("elo", ascending=False).reset_index(drop=True)
    df.insert(0, "rank", df.index + 1)
    return df


def model_info(snapshot_path: str = DEFAULT_SNAPSHOT) -> dict:
    """Return a summary of the trained model."""
    snap = _load(snapshot_path)
    return {
        "snapshot_path": snapshot_path,
        "as_of_season": snap.get("as_of_season"),
        "trained_through": snap.get("trained_through"),
        "params": snap["params"],
        "n_teams": len(snap["ratings"]),
        "n_starting_qbs_tracked": len(snap.get("team_starting_qb", {})),
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="NFL Elo prediction CLI")
    sub = ap.add_subparsers(dest="cmd")

    p_pred = sub.add_parser("predict", help="predict one game")
    p_pred.add_argument("team_a")
    p_pred.add_argument("team_b")
    p_pred.add_argument("--neutral", action="store_true")
    p_pred.add_argument("--spread", type=float, default=None,
                         help="market spread (home perspective; +ve ⇒ home favored)")
    p_pred.add_argument("--season", type=int, default=None)
    p_pred.add_argument("--home-qb", default=None,
                         help="home team starting QB id (nflverse)")
    p_pred.add_argument("--away-qb", default=None,
                         help="away team starting QB id (nflverse)")

    p_rank = sub.add_parser("rankings", help="show current Elo rankings")
    p_rank.add_argument("--top", type=int, default=10)

    p_info = sub.add_parser("info", help="model info")

    args = ap.parse_args()
    if args.cmd == "predict":
        out = predict(args.team_a, args.team_b, neutral=args.neutral,
                       spread=args.spread, season=args.season,
                       home_qb=args.home_qb, away_qb=args.away_qb)
        print(json.dumps(out, indent=2))
    elif args.cmd == "rankings":
        df = team_ratings().head(args.top)
        print(df.to_string(index=False))
    elif args.cmd == "info":
        print(json.dumps(model_info(), indent=2))
    else:
        ap.print_help()