"""Elo rating core for NFL games.

Design (see README):
- Base K = 20 (NFL has 17 games/season → data sparse vs Dota2 K=32)
- Home advantage ≈ 65 Elo points (NFL home win rate ~57%)
- Margin-of-Victory multiplier (FiveThirtyEight style):
    mov_mult = ln(PD + 1) * (2.2 / ((elo_diff) * 0.001 + 2.2))
- Season mean-reversion: each team reverts 40% toward 1500 at season start

This module is intentionally pure-Python / no pandas dependency so it can be unit-tested.
"""

from __future__ import annotations
import math
from dataclasses import dataclass, field


# ---- Defaults tuned for NFL --------------------------------------------------
DEFAULT_K = 20.0
DEFAULT_HOME_ADV = 65.0
DEFAULT_MOV_C = 2.2
DEFAULT_ELO_DENOM = 400.0
DEFAULT_REVERSION = 0.40          # toward 1500 each new season
DEFAULT_START_ELO = 1500.0


def expected_score(elo_a: float, elo_b: float, denom: float = DEFAULT_ELO_DENOM) -> float:
    """Expected score (win prob) of A against B from Elo ratings."""
    return 1.0 / (1.0 + 10.0 ** ((elo_b - elo_a) / denom))


def mov_multiplier(point_diff: float, elo_diff: float, c: float = DEFAULT_MOV_C) -> float:
    """Margin-of-victory multiplier (538 formulation).

    Larger margin → bigger swing; close Elo → bigger swing; bigger Elo gap dampens it.
    """
    pd = max(point_diff, 1)  # avoid log(0); ties / 1-point wins still update
    elo_term = (elo_diff * 0.001 + c)
    return math.log(pd + 1.0) * (c / elo_term)


@dataclass
class EloSystem:
    k: float = DEFAULT_K
    home_adv: float = DEFAULT_HOME_ADV
    mov_c: float = DEFAULT_MOV_C
    reversion: float = DEFAULT_REVERSION
    start_elo: float = DEFAULT_START_ELO
    ratings: dict[str, float] = field(default_factory=dict)
    last_season: dict[str, int] = field(default_factory=dict)

    def get(self, team: str) -> float:
        return self.ratings.get(team, self.start_elo)

    def _revert_if_new_season(self, team: str, season: int) -> float:
        """Pull team rating toward league mean at season start (mean reversion)."""
        if team not in self.ratings:
            self.ratings[team] = self.start_elo
            self.last_season[team] = season
            return self.start_elo
        if self.last_season[team] != season:
            cur = self.ratings[team]
            self.ratings[team] = cur + (self.start_elo - cur) * self.reversion
        self.last_season[team] = season
        return self.ratings[team]

    def predict(
        self,
        home_team: str,
        away_team: str,
        season: int | None = None,
        neutral: bool = False,
    ) -> tuple[float, float]:
        """Return (win_prob_home, win_prob_away) BEFORE applying home advantage.

        Season argument triggers mean-reversion lookups; if None, no revert.
        """
        if season is not None:
            self._revert_if_new_season(home_team, season)
            self._revert_if_new_season(away_team, season)
        h = self.get(home_team)
        a = self.get(away_team)
        if not neutral:
            h += self.home_adv
        p_home = expected_score(h, a)
        return p_home, 1.0 - p_home

    def update(
        self,
        winner: str,
        loser: str,
        point_diff: float,
        season: int | None = None,
        neutral: bool = False,
    ) -> tuple[float, float, float]:
        """Apply rating update after a game; return (winner_new, loser_new, mov_mult)."""
        if season is not None:
            self._revert_if_new_season(winner, season)
            self._revert_if_new_season(loser, season)
        w = self.get(winner)
        l = self.get(loser)
        # Treat updater view as if winner was home (winner-of-update gets the home bump
        # in prediction, but here we just measure difference between raw Elos).
        # For neutral-site games this is fine because home adv is symmetric.
        elo_diff = w - l  # without home adv
        mm = mov_multiplier(point_diff, elo_diff, self.mov_c)
        e_w = expected_score(w, l)
        e_l = 1.0 - e_w
        delta = self.k * mm
        w_new = w + delta * (1.0 - e_w)
        l_new = l + delta * (0.0 - e_l)
        self.ratings[winner] = w_new
        self.ratings[loser] = l_new
        if season is not None:
            self.last_season[winner] = season
            self.last_season[loser] = season
        return w_new, l_new, mm