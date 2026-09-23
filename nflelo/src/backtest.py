"""Walk-forward backtest for NFL Elo model.

Iterates games chronologically; BEFORE each game, snapshots predicted win prob;
AFTER each game, applies Elo update.

Evaluates:
  - Brier score
  - Log loss
  - HC@75 / HC@65 / HC@55 (hit rate when predicted prob >= threshold)
  - Per-season breakdown
"""

from __future__ import annotations
from dataclasses import dataclass, field
import math
from typing import Iterable

import pandas as pd

from elo import EloSystem


@dataclass
class BacktestResult:
    rows: list[dict] = field(default_factory=list)

    def to_df(self) -> pd.DataFrame:
        return pd.DataFrame(self.rows)


def _safe_log(p: float) -> float:
    p = max(min(p, 1.0 - 1e-9), 1e-9)
    return math.log(p)


def hc_at(df: pd.DataFrame, threshold: float) -> dict:
    """Compute hit rate on games where predicted prob >= threshold.

    Returns n_filtered, n_won, hit_rate, avg_pred, actual.
    """
    sub = df[df["pred_home"] >= threshold]
    if len(sub) == 0:
        return {"threshold": threshold, "n": 0, "n_won": 0, "hit_rate": None, "avg_pred": None, "actual": None}
    n = len(sub)
    won = int(sub["home_win"].sum())
    return {
        "threshold": threshold,
        "n": n,
        "n_won": won,
        "hit_rate": won / n,
        "avg_pred": float(sub["pred_home"].mean()),
        "actual": won / n,
    }


def evaluate(df: pd.DataFrame) -> dict:
    """Compute aggregate metrics over a backtest result df."""
    p = df["pred_home"].clip(1e-9, 1 - 1e-9).values
    y = df["home_win"].astype(int).values
    n = len(df)
    brier = float(((p - y) ** 2).mean())
    logloss = float(-(y * np_log(p) + (1 - y) * np_log(1 - p)).mean())
    # winsorize is unnecessary; clip already done
    return {
        "n": n,
        "brier": brier,
        "logloss": logloss,
        "hc75": hc_at(df, 0.75),
        "hc65": hc_at(df, 0.65),
        "hc55": hc_at(df, 0.55),
        "overall_acc": float(((p >= 0.5).astype(int) == y).mean()),
    }


def np_log(arr):
    import numpy as np
    return np.log(arr)


def run_backtest(games: pd.DataFrame, system: EloSystem, eval_seasons: Iterable[int] | None = None) -> pd.DataFrame:
    """Run walk-forward backtest.

    games must have columns: season, week, home_team, away_team, home_score, away_score
    Sorted by season, week before calling.
    eval_seasons: if given, only include predictions in these seasons in output (training
    games still update Elo, just not recorded).
    """
    rows: list[dict] = []
    for _, g in games.iterrows():
        season = int(g["season"])
        home = g["home_team"]
        away = g["away_team"]
        if pd.isna(home) or pd.isna(away):
            continue
        hs = g["home_score"]
        as_ = g["away_score"]
        if pd.isna(hs) or pd.isna(as_):
            # Not yet played / future — skip
            continue
        point_diff = float(hs) - float(as_)
        winner = home if point_diff > 0 else away
        loser = away if point_diff > 0 else home
        neutral = (g.get("location") == "Neutral") if "location" in g.index else False
        p_home, p_away = system.predict(home, away, season=season, neutral=neutral)
        if eval_seasons is None or season in set(eval_seasons):
            rows.append({
                "season": season,
                "week": int(g["week"]),
                "game_id": g.get("game_id"),
                "home_team": home,
                "away_team": away,
                "home_score": float(hs),
                "away_score": float(as_),
                "point_diff": point_diff,
                "pred_home": float(p_home),
                "home_win": int(point_diff > 0),
                "neutral": neutral,
            })
        system.update(winner, loser, point_diff, season=season, neutral=neutral)
    return pd.DataFrame(rows)


def load_games(path: str = "data/raw/games.csv") -> pd.DataFrame:
    df = pd.read_csv(path)
    # Filter regular + postseason only (drop PRESEASON if any)
    if "game_type" in df.columns:
        df = df[df["game_type"].isin(["REG", "POST"])].copy()
    df = df.dropna(subset=["home_score", "away_score"]).copy()
    df = df.sort_values(["season", "week"]).reset_index(drop=True)
    return df