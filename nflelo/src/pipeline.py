"""NFL Elo pipeline helpers used by run_p2*.py.

Includes:
  - run_backtest(...)              -> DataFrame of predictions
  - evaluate(...)                  -> aggregate metrics incl. HC@75/65/55
  - elo_system factory with composite-rating + sqrt-MoV variants

Composite rating (rolling PPG / PAPG / PD) blends a power term into the
pre-game Elo used for prediction (it does NOT alter the Elo rating itself).
"""

from __future__ import annotations
from dataclasses import dataclass, field
import math
from collections import defaultdict, deque, Counter
from typing import Iterable, Callable

import numpy as np
import pandas as pd


START_ELO = 1500.0


# ---- MoV variants -----------------------------------------------------------

def mov_log(elo_diff: float, point_diff: float, c: float = 2.2) -> float:
    """Classic FiveThirtyEight MoV: ln(PD+1) * (c / (elo_diff*0.001 + c))."""
    pd_ = max(point_diff, 1)
    return math.log(pd_ + 1.0) * (c / (elo_diff * 0.001 + c))


def mov_sqrt(elo_diff: float, point_diff: float, c: float = 2.2) -> float:
    """538 v2 / Sumsquare: sqrt(PD) * (c / (elo_diff*0.001 + c))."""
    pd_ = max(point_diff, 1)
    return math.sqrt(pd_) * (c / (elo_diff * 0.001 + c))


MOV_FUNCS = {"log": mov_log, "sqrt": mov_sqrt}


# ---- Elo system --------------------------------------------------------------

@dataclass
class EloSystem:
    k: float = 20.0
    home_adv: float = 65.0
    reversion: float = 0.40
    start_elo: float = START_ELO
    mov_fn: Callable = mov_log
    mov_c: float = 2.2
    spread_to_elo: float = 0.0  # 0 disables market-spread contribution
    spread_threshold: float = 0.0  # Elo diff above which spread is ignored (0 = always on)
    qb_weight: float = 0.0  # 0 disables QB Elo contribution
    qb_k: float = 20.0
    qb_ratings: dict[str, float] = field(default_factory=dict)
    qb_last_season: dict[str, int] = field(default_factory=dict)
    backup_qb_penalty: float = 0.0  # Elo penalty when team's QB is a backup (0 disables)
    team_starting_qb: dict[str, str] = field(default_factory=dict)  # per team, most-frequent QB seen
    team_qb_history: dict[str, deque] = field(default_factory=dict)  # last 4 QBs per team

    ratings: dict[str, float] = field(default_factory=dict)
    last_season: dict[str, int] = field(default_factory=dict)
    composite: dict[str, float] = field(default_factory=dict)  # power rating add-on

    def get(self, team: str) -> float:
        return self.ratings.get(team, self.start_elo)

    def _ensure(self, team: str, season: int) -> float:
        if team not in self.ratings:
            self.ratings[team] = self.start_elo
            self.last_season[team] = season
        if self.last_season[team] != season:
            self.ratings[team] += (self.start_elo - self.ratings[team]) * self.reversion
            self.last_season[team] = season
        return self.ratings[team]

    def predict(self, home: str, away: str, season: int, neutral: bool = False,
                spread: float | None = None, spread_to_elo: float = 0.0,
                spread_threshold: float = 0.0,
                home_qb: str | None = None, away_qb: str | None = None):
        """Predict home-team win prob.

        spread (optional): market closing spread_line. Convention (from nflverse
        schedules.csv): negative ⇒ home team is the underdog by |spread| points.
        E.g. spread = -3.0 ⇒ home is +3 underdog ⇒ home Elo should DROP.
        Multiplied by spread_to_elo to convert points → Elo. Set spread_to_elo=0
        to disable spread contribution.

        spread_threshold: only apply spread when |elo_diff_pre_spread| < threshold.
        0 (or any value <= 0) ⇒ always apply when spread_to_elo > 0.

        home_qb / away_qb: optional QB ids. If both provided AND qb_weight > 0,
        QB Elo diff contributes qb_weight * (h_qb - a_qb) to the home Elo diff.

        Backup QB detection — if backup_qb_penalty > 0 and a team's QB is not its
        declared starting QB, that team's Elo is reduced by backup_qb_penalty.
        """
        self._ensure(home, season); self._ensure(away, season)
        h = self.get(home); a = self.get(away)
        if not neutral:
            h += self.home_adv
        # Composite add-on (z-score scale; only for prediction, not stored in Elo)
        h += self.composite.get(home, 0.0)
        a += self.composite.get(away, 0.0)
        # Backup QB penalty — only if QB != team's declared starter
        if self.backup_qb_penalty > 0:
            if home_qb is not None and self.team_starting_qb.get(home) and \
                    home_qb != self.team_starting_qb[home]:
                h -= self.backup_qb_penalty
            if away_qb is not None and self.team_starting_qb.get(away) and \
                    away_qb != self.team_starting_qb[away]:
                a -= self.backup_qb_penalty
        # Conditional spread: only kick in when Elo is undecided
        apply_spread = (spread is not None
                        and not (isinstance(spread, float) and math.isnan(spread))
                        and spread_to_elo > 0)
        if apply_spread and spread_threshold > 0:
            elo_diff_pre = abs(h - a)
            if elo_diff_pre >= spread_threshold:
                apply_spread = False
        if apply_spread:
            h += float(spread) * spread_to_elo
        # QB Elo add-on (no mean-reversion within season; QB rating reflects season sample)
        if self.qb_weight > 0 and home_qb is not None and away_qb is not None:
            h_qb = self.qb_ratings.get(home_qb, START_ELO)
            a_qb = self.qb_ratings.get(away_qb, START_ELO)
            h += (h_qb - a_qb) * self.qb_weight
        e = 1.0 / (1.0 + 10.0 ** ((a - h) / 400.0))
        return e, 1.0 - e

    def update(self, winner: str, loser: str, point_diff: float, season: int, neutral: bool = False,
                 winner_qb: str | None = None, loser_qb: str | None = None):
        self._ensure(winner, season); self._ensure(loser, season)
        w = self.get(winner); l = self.get(loser)
        mm = self.mov_fn(w - l, point_diff, self.mov_c)
        e_w = 1.0 / (1.0 + 10.0 ** ((l - w) / 400.0))
        delta = self.k * mm
        self.ratings[winner] = w + delta * (1.0 - e_w)
        self.ratings[loser] = l + delta * (0.0 - (1.0 - e_w))
        # QB Elo update (no MoV — single QB signal too noisy for margin weighting)
        if self.qb_weight > 0 and winner_qb is not None and loser_qb is not None:
            w_qb = self.qb_ratings.get(winner_qb, START_ELO)
            l_qb = self.qb_ratings.get(loser_qb, START_ELO)
            e_qb_w = 1.0 / (1.0 + 10.0 ** ((l_qb - w_qb) / 400.0))
            delta_qb = self.qb_k * (1.0 - e_qb_w)
            self.qb_ratings[winner_qb] = w_qb + delta_qb
            self.qb_ratings[loser_qb] = l_qb - delta_qb
            self.qb_last_season[winner_qb] = season
            self.qb_last_season[loser_qb] = season
        # Track team starting QB (the QB seen this game; updates each week so
        # mid-season starter changes are captured).
        if winner_qb is not None:
            self._record_team_qb(winner, winner_qb)
        if loser_qb is not None:
            self._record_team_qb(loser, loser_qb)
        return self.ratings[winner], self.ratings[loser], mm

    def _record_team_qb(self, team: str, qb: str):
        """Record a QB appearance and update team's starting QB (most-frequent in last 4 games)."""
        if team not in self.team_qb_history:
            self.team_qb_history[team] = deque(maxlen=4)
        self.team_qb_history[team].append(qb)
        counter = Counter(self.team_qb_history[team])
        self.team_starting_qb[team] = counter.most_common(1)[0][0]


# ---- Composite (rolling PPG / PAPG / PD) ----------------------------------

class CompositeTracker:
    """Rolling team stats: PPG scored, PAPG allowed, PD per game.

    Maintains last N (default 8) game window per team. Returns z-scored
    composite power rating (centered at 0, league-relative) so it can be
    added directly to an Elo scale.
    """
    def __init__(self, window: int = 8):
        self.window = window
        self.scored: dict[str, deque] = defaultdict(lambda: deque(maxlen=self.window))
        self.allowed: dict[str, deque] = defaultdict(lambda: deque(maxlen=self.window))
        self.n: dict[str, int] = defaultdict(int)
        # league rolling stats for z-score normalization (use last 256 games ~ 1 season)
        self._league_scored: deque = deque(maxlen=256)
        self._league_allowed: deque = deque(maxlen=256)

    def record(self, team: str, scored: float, allowed: float):
        self.scored[team].append(scored)
        self.allowed[team].append(allowed)
        self.n[team] += 1
        self._league_scored.append(scored)
        self._league_allowed.append(allowed)

    def power_rating(self, team: str) -> float:
        """Composite power in Elo-scale (~±100). Returns 0 for teams with no history."""
        if len(self.scored[team]) < 3:
            return 0.0
        ppg = float(np.mean(self.scored[team]))
        papg = float(np.mean(self.allowed[team]))
        pd = ppg - papg
        # league baseline
        league_ppg = float(np.mean(self._league_scored)) if self._league_scored else 22.0
        league_papg = float(np.mean(self._league_allowed)) if self._league_allowed else 22.0
        # z-scored PD relative to league (~10-15 pts spread)
        league_pd_std = max(float(np.std(self._league_scored) + np.std(self._league_allowed)) / 2, 5.0)
        z = (pd - (league_ppg - league_papg)) / league_pd_std
        # scale: z=1 ≈ +70 Elo (1 SD of NFL team quality ≈ 70 Elo pts per FiveThirtyEight)
        return z * 70.0


def update_composite(system: EloSystem, comp: CompositeTracker, games: pd.DataFrame, eval_seasons: Iterable[int] | None,
                       use_composite: bool = True, train_through_season: int | None = None):
    """Walk-forward backtest with composite-rating-aware prediction.

    composite is updated every game (after recording the result). Only seasons
    in eval_seasons produce prediction rows; but rating updates always happen
    so the model accumulates information correctly.

    use_composite=False disables the rolling PPG/PAPG/PD add-on (for fair
    ablation comparisons against pure Elo + spread).

    train_through_season: if set, ignore games with season > this (don't update
    ratings, don't record predictions). Useful for snapshot generation where
    you want final ratings as-of a specific season.
    """
    rows_eval: list[dict] = []
    eval_set = set(eval_seasons) if eval_seasons is not None else None
    for _, g in games.iterrows():
        season = int(g["season"])
        if train_through_season is not None and season > train_through_season:
            continue
        home = g["home_team"]; away = g["away_team"]
        hs = g["home_score"]; as_ = g["away_score"]
        if pd.isna(home) or pd.isna(away) or pd.isna(hs) or pd.isna(as_):
            continue
        hs = float(hs); as_ = float(as_)
        point_diff = hs - as_
        neutral = (g.get("location") == "Neutral") if "location" in g.index else False

        if use_composite:
            system.composite[home] = comp.power_rating(home)
            system.composite[away] = comp.power_rating(away)
        else:
            system.composite[home] = 0.0
            system.composite[away] = 0.0

        spread_val = g.get("spread_line") if "spread_line" in g.index else None
        home_qb = g.get("home_qb_id") if "home_qb_id" in g.index else None
        away_qb = g.get("away_qb_id") if "away_qb_id" in g.index else None
        p_home, _ = system.predict(home, away, season=season, neutral=neutral,
                                    spread=spread_val, spread_to_elo=system.spread_to_elo,
                                    spread_threshold=system.spread_threshold,
                                    home_qb=home_qb, away_qb=away_qb)

        if eval_set is None or season in eval_set:
            rows_eval.append({
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

        # After prediction: apply Elo update AND record composite stats for next game.
        winner = home if point_diff > 0 else away
        loser = away if point_diff > 0 else home
        winner_qb = home_qb if winner == home else away_qb
        loser_qb = away_qb if loser == away else home_qb
        if winner == home:
            system.update(home, away, point_diff, season=season, neutral=neutral,
                           winner_qb=winner_qb, loser_qb=loser_qb)
            comp.record(home, hs, as_)
            comp.record(away, as_, hs)
        else:
            system.update(away, home, -point_diff, season=season, neutral=neutral,
                           winner_qb=winner_qb, loser_qb=loser_qb)
            comp.record(home, hs, as_)
            comp.record(away, as_, hs)
    return pd.DataFrame(rows_eval)


# ---- Metrics ---------------------------------------------------------------

def evaluate(df: pd.DataFrame) -> dict:
    p = df["pred_home"].clip(1e-9, 1 - 1e-9).values
    y = df["home_win"].astype(int).values
    n = len(df)
    brier = float(((p - y) ** 2).mean())
    logloss = float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    acc = float(((p >= 0.5).astype(int) == y).mean())

    def hc(thr):
        sub = df[df["pred_home"] >= thr]
        if len(sub) == 0:
            return {"threshold": thr, "n": 0, "hit_rate": None, "avg_pred": None}
        n_ = len(sub)
        won = int(sub["home_win"].sum())
        return {"threshold": thr, "n": n_, "hit_rate": won / n_,
                "avg_pred": float(sub["pred_home"].mean())}
    return {
        "n": n,
        "brier": brier,
        "logloss": logloss,
        "acc": acc,
        "hc75": hc(0.75),
        "hc65": hc(0.65),
        "hc55": hc(0.55),
    }


def fmt_metrics(name: str, m: dict) -> str:
    h75 = m["hc75"]; h65 = m["hc65"]; h55 = m["hc55"]

    def hr(h):
        return f"{h['hit_rate']:.3f}({h['n']:>4})" if h["hit_rate"] is not None else f"   N/A({h['n']:>4})"

    s = (f"{name:>22}  N={m['n']:>4}  "
         f"Brier={m['brier']:.4f}  LL={m['logloss']:.4f}  Acc={m['acc']:.3f}  "
         f"HC75={hr(h75)}  "
         f"HC65={hr(h65)}  "
         f"HC55={hr(h55)}")
    return s