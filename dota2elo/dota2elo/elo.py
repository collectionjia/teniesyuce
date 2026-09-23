"""Elo 引擎 + 复合评分 + 高置信过滤 + Upset Risk 调整。

融合了 ~/Documents/Default Project/dota2-elo/ 的算法思想 + 现有的基础 Elo 引擎。

设计：保留向后兼容。`expected_win`/`update_ratings` 用基础 team_elo；
`composite_rating` 等高级 API 在数据不全时优雅降级到 team_elo。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .config import (
    DEFAULT_K,
    ELO_CEILING,
    ELO_FLOOR,
    INITIAL_ELO,
    K_BY_SERIES_TYPE,
    PROVISIONAL_MATCHES,
    k_factor_for_league,
)


# =================================================================
# 基础 Elo（保留原接口，向后兼容）
# =================================================================
@dataclass
class EloUpdate:
    team_id: int
    opponent_id: int
    elo_before: float
    elo_after: float
    k_used: float
    expected: float
    actual: float


def expected_win(elo_a: float, elo_b: float) -> float:
    """A 战胜 B 的期望概率。"""
    return 1.0 / (1.0 + 10 ** ((elo_b - elo_a) / 400.0))


def _clamp(r: float) -> float:
    return max(ELO_FLOOR, min(ELO_CEILING, r))


def _k_for(base_k: float, matches_played: int) -> float:
    """新战队头 N 场用 2x K 加速收敛。"""
    if matches_played < PROVISIONAL_MATCHES:
        return base_k * 2.0
    return base_k


# =================================================================
# v1.5 Bayesian 收缩（解决低样本队 Elo 极化问题）
# =================================================================
SHRINKAGE_K = 15  # 收缩强度：k=15 → 15 场 = 50% 收缩，30 场 = 67%, 50 场 = 77%

def apply_bayesian_shrinkage(
    elo: float,
    n: int,
    prior: float = INITIAL_ELO,
    k: int = SHRINKAGE_K,
) -> float:
    """Bayesian shrinkage 把低样本队的 Elo 拉回先验（默认 1500）。

    公式：effective = prior + (n / (n + k)) * (actual - prior)

    - n=0 时 100% 收缩（= prior）
    - n=k 时 50% 收缩
    - n→∞ 时不收缩（= actual）

    解决：Pibbles Corp (10 场 9-1, Elo 1559) vs Xtreme Gaming (259 场 46% WR, Elo 1520)
    —— 低样本队 9-1 的 Elo 虚高 60+ 分，shrunken 后会被拉回 1510 左右。
    """
    weight = n / (n + k)
    return prior + weight * (elo - prior)


# =================================================================
# v1.5 Tier-aware K 因子
# =================================================================
def tier_modifier_k(winner_tier: int, loser_tier: int) -> float:
    """根据胜方和败方的联赛层级调整 Elo 更新幅度。

    tier 数字越小越顶级（T1=1, T2=2, T3=3, T4=4）。
    gap = winner_tier - loser_tier，正数表示弱队爆冷赢强队。

    - gap = -2 (T1 赢 T3)：完全预期内，大幅折扣 (0.5x)
    - gap = -1 (T1 赢 T2)：预期，折扣 (0.75x)
    - gap =  0 (同级)：正常 (1.0x)
    - gap = +1 (T2 赢 T1)：小爆冷，加成 (1.25x)
    - gap = +2 (T3 赢 T1)：大爆冷，强加成 (1.75x)
    """
    gap = winner_tier - loser_tier
    if gap <= -2:
        return 0.5
    if gap == -1:
        return 0.75
    if gap == 0:
        return 1.0
    if gap == 1:
        return 1.25
    return 1.75  # gap >= +2


def update_ratings(
    rating_a: float,
    rating_b: float,
    score_a: float,
    base_k: float,
    matches_played_a: int = PROVISIONAL_MATCHES,
    matches_played_b: int = PROVISIONAL_MATCHES,
    tier_a: Optional[int] = None,
    tier_b: Optional[int] = None,
) -> Tuple[float, float, float, float]:
    """Elo 更新，返回 (new_a, new_b, expected_a, k_used)。

    v1.5 新增 tier_a / tier_b 参数：传入联赛层级时按 tier_modifier_k 调整增量。
    """
    k_a = _k_for(base_k, matches_played_a)
    k_b = _k_for(base_k, matches_played_b)
    k = (k_a + k_b) / 2.0
    # v1.5 tier 调整
    if tier_a is not None and tier_b is not None:
        if score_a > 0.5:  # A 赢
            k *= tier_modifier_k(tier_a, tier_b)
        else:  # B 赢
            k *= tier_modifier_k(tier_b, tier_a)
    e_a = expected_win(rating_a, rating_b)
    e_b = 1.0 - e_a
    new_a = _clamp(rating_a + k * (score_a - e_a))
    new_b = _clamp(rating_b + k * ((1.0 - score_a) - e_b))
    return new_a, new_b, e_a, k


# =================================================================
# K 因子（按 series_type + league 联合判断）
# =================================================================
def _series_type_to_int(series_type) -> Optional[int]:
    """归一化 series_type 输入为整数（支持 "bo1"/"bo3"/"bo5" 字符串和 0/1/2 整数）。"""
    if series_type is None:
        return None
    if isinstance(series_type, int):
        return series_type
    s = str(series_type).strip().lower()
    if s in ("bo1", "1", "best_of_1"):
        return 0
    if s in ("bo3", "3", "best_of_3"):
        return 1
    if s in ("bo5", "5", "best_of_5"):
        return 2
    return None


def k_factor(series_type=None, league_name: Optional[str] = None) -> float:
    """根据 series_type 选 K 因子；缺时回退到 league 名匹配。"""
    st = _series_type_to_int(series_type)
    if st is not None and st in K_BY_SERIES_TYPE:
        return K_BY_SERIES_TYPE[st]
    return k_factor_for_league(league_name)


# =================================================================
# 复合评分（4 维加权）— 融合你的 engine.py
# =================================================================
@dataclass
class TeamRating:
    """完整战队评分状态。

    字段全时算 4 维复合分；字段缺时优雅降级到 team_elo。
    """
    team_id: int
    name: str = ""
    team_elo: float = INITIAL_ELO
    player_elo: Dict[str, float] = field(default_factory=dict)        # 玩家级别（v1.5: key 实际是 int player_id）
    player_matches: Dict[str, int] = field(default_factory=dict)      # v1.5: 每个选手的比赛数（用于 Bayesian 收缩）
    hero_pool_rating: Dict[str, float] = field(default_factory=dict)  # 英雄胜率 %
    patch_rating: Dict[str, float] = field(default_factory=dict)      # 补丁胜率 delta
    roster_stability: float = 1.0
    confidence: float = 1.0
    games: int = 0
    # K-mult 系数（用于回测 grid search）
    k_mult: float = 1.0
    # 历史胜率（用于"underdog_streak" 判断）
    recent_results: List[bool] = field(default_factory=list)


@dataclass
class Weights:
    team: float = 0.55
    player: float = 0.20
    hero: float = 0.15
    patch: float = 0.10


DEFAULT_WEIGHTS = Weights()


def roster_power(team: TeamRating) -> float:
    """5 个玩家 Elo 均值（v1.5 Bayesian 收缩）；没有时回退到 team_elo。

    每个选手按其 matches 数收缩：低样本选手拉回 1500，避免被新选手的虚高 Elo 污染。
    """
    if not team.player_elo:
        return team.team_elo
    total = 0.0
    for pid, elo in team.player_elo.items():
        # player_matches 字典有就取，没有按 0 收缩
        n = team.player_matches.get(pid, 0) if team.player_matches else 0
        total += apply_bayesian_shrinkage(elo, n)
    return total / len(team.player_elo)


def hero_strength_delta(team: TeamRating) -> float:
    """英雄池胜率相对 50% 基准的差，乘 2 缩放到 Elo 量级。"""
    if not team.hero_pool_rating:
        return 0.0
    avg_wr = sum(team.hero_pool_rating.values()) / len(team.hero_pool_rating)
    return (avg_wr - 50.0) * 2.0


def hero_elo(team: TeamRating) -> float:
    return team.team_elo + hero_strength_delta(team)


def patch_elo(team: TeamRating, patch: Optional[str] = None) -> float:
    """当前补丁的胜率加成；没有该补丁时取所有补丁均值。"""
    if patch and patch in team.patch_rating:
        return team.team_elo + team.patch_rating[patch]
    if team.patch_rating:
        avg = sum(team.patch_rating.values()) / len(team.patch_rating)
        return team.team_elo + avg
    return team.team_elo


def draft_advantage(
    team_a: TeamRating, team_b: TeamRating
) -> float:
    """双方英雄池胜率差，clamp 到 [-100, 100]。"""
    if not team_a.hero_pool_rating or not team_b.hero_pool_rating:
        return 0.0
    wa = sum(team_a.hero_pool_rating.values()) / len(team_a.hero_pool_rating)
    wb = sum(team_b.hero_pool_rating.values()) / len(team_b.hero_pool_rating)
    return max(-100.0, min(100.0, (wa - wb) * 2.0))


def stability_factor(team: TeamRating) -> float:
    return max(0.0, min(team.roster_stability, 1.0))


def tier_elo_offset(tier: Optional[int]) -> float:
    """v1.5 方案 5: 联赛层级 → Elo 偏移。

    T1 队在 T1 联赛反复输给其他 T1 队，Elo 被低估 → 补偿 +20
    T2 队 +5
    T3 队 -10（高估了 vs 弱队的胜率）
    T4 队 -25
    """
    if tier is None:
        return 0.0
    return {1: 20.0, 2: 5.0, 3: -10.0, 4: -25.0}.get(tier, 0.0)


def composite_rating(
    team: TeamRating,
    patch: Optional[str] = None,
    weights: Weights = DEFAULT_WEIGHTS,
    tier: Optional[int] = None,
    tier_elo: Optional[float] = None,  # v1.6: 直接传入 per-tier Elo
    tier_games: int = 0,  # v1.6: per-tier 的 games 数（用于 Bayesian 收缩）
    opp_tier: Optional[int] = None,  # v1.6: 对手 tier（决定用 per-tier 还是 raw）
) -> float:
    """4 维加权综合分（乘以稳定性系数）。

    v1.6 混合方案：
    - 跨层（tier != opp_tier）：用 per-tier Elo + 收缩
    - 同层（tier == opp_tier 或未知）：用 raw team_elo + tier_offset
    """
    sf = stability_factor(team)
    pr = roster_power(team)
    he = hero_elo(team)
    pe = patch_elo(team, patch)
    cross_tier = tier is not None and opp_tier is not None and tier != opp_tier
    use_per_tier = cross_tier and tier_elo is not None
    if use_per_tier:
        # 跨层：per-tier + 半强度 offset（per-tier 已隔离一部分上下文，offset 减半避免过补偿）
        effective_team_elo = apply_bayesian_shrinkage(tier_elo, tier_games)
        effective_team_elo += tier_elo_offset(tier) * 0.5
    else:
        effective_team_elo = apply_bayesian_shrinkage(team.team_elo, team.games)
        effective_team_elo += tier_elo_offset(tier)
    base = (
        weights.team * effective_team_elo
        + weights.player * pr
        + weights.hero * he
        + weights.patch * pe
    )
    return sf * base


# =================================================================
# 预测（含 draft + upset risk）
# =================================================================
def predict(
    team_a: TeamRating,
    team_b: TeamRating,
    patch: Optional[str] = None,
    draft_adv_a: float = 0.0,
    draft_adv_b: float = 0.0,
    scale: float = 1.0,
    weights: Weights = DEFAULT_WEIGHTS,
    tier_a: Optional[int] = None,
    tier_b: Optional[int] = None,
    tier_elo_a: Optional[float] = None,
    tier_elo_b: Optional[float] = None,
    tier_games_a: int = 0,
    tier_games_b: int = 0,
) -> Tuple[float, float]:
    """A 胜概率 + Elo 差。

    v1.6 混合方案：
    - 跨层比赛：用 per-tier Elo（解决方向错误）
    - 同层比赛：用 raw Elo + tier_offset（保持 v1.5 数值）
    """
    ra = composite_rating(team_a, patch, weights,
                           tier=tier_a, tier_elo=tier_elo_a,
                           tier_games=tier_games_a, opp_tier=tier_b) + draft_adv_a
    rb = composite_rating(team_b, patch, weights,
                           tier=tier_b, tier_elo=tier_elo_b,
                           tier_games=tier_games_b, opp_tier=tier_a) + draft_adv_b
    diff = ra - rb
    p = 1.0 / (1.0 + 10.0 ** (-diff / (400.0 * scale)))
    return p, diff


def form_modifier(team: TeamRating) -> float:
    """近期胜率（50% 基准）映射到 ±60 Elo 范围。"""
    if not team.recent_results:
        return 0.0
    return (sum(team.recent_results) / len(team.recent_results) - 0.5) * 120.0


def match_rating(
    team: TeamRating,
    patch: Optional[str] = None,
    draft_adv: float = 0.0,
    weights: Weights = DEFAULT_WEIGHTS,
) -> float:
    """完整比赛评级（用于 process_match 等）。"""
    return composite_rating(team, patch, weights) + draft_adv + form_modifier(team)


# =================================================================
# 高置信过滤（5 条联合）
# =================================================================
HIGH_CONFIDENCE_THRESHOLD = 0.85


def is_high_confidence(
    team_a: TeamRating,
    team_b: TeamRating,
    series_type: Optional[int] = None,
    patch: Optional[str] = None,
    draft_adv_a: float = 0.0,
    draft_adv_b: float = 0.0,
    weights: Weights = DEFAULT_WEIGHTS,
) -> bool:
    """高置信预测：5 条联合判断，比单阈值严格。"""
    p_a, _ = predict(team_a, team_b, patch, draft_adv_a, draft_adv_b, weights=weights)
    if p_a < HIGH_CONFIDENCE_THRESHOLD:
        return False
    # 1) 不是 BO1（BO1 翻车率高）
    if series_type == 0:
        return False
    # 2) 复合分差 >= 300
    diff = composite_rating(team_a, patch, weights) - composite_rating(team_b, patch, weights)
    if diff < 300:
        return False
    # 3) 阵容稳定性 >= 0.8
    if team_a.roster_stability <= 0.8:
        return False
    # 4) 补丁优势 > 0
    if patch_elo(team_a, patch) - patch_elo(team_b, patch) <= 0:
        return False
    # 5) BP 优势 > 0
    if draft_adv_a - draft_adv_b <= 0:
        return False
    return True


# =================================================================
# 实战 75% 胜率条件（基于 2371 场职业比赛回测，2026-09-04 更新）
# =================================================================
# 这些不是"理论条件"，而是历史数据中**实际兑现 75%+ 胜率**的赛前信号。
# 详见 scripts/find_high_winrate.py。
#
# v1.2 更新（2026-09-04）：
#   - 阈值从 300 降到 200（新数据下 200-300 Elo 差实际胜率 85%+）
#   - BO1 + 差 200+ 升为最强信号（95.5%, 22 场）
#   - Top 5 + 差 150+ + 高状态升至 88.1%
WINRATE_75_THRESHOLD = 0.75
ELO_DIFF_THRESHOLD = 200  # 从 300 下调


@dataclass
class Winrate75Result:
    """75% 胜率条件评估结果。"""
    meets: bool                     # 是否满足任一条件
    met_conditions: List[str]       # 满足的条件列表
    best_signal: str                # 单一最强信号（胜率最高）
    best_signal_winrate: float      # 该信号的历史胜率
    expected_winrate: float         # 综合预期胜率（取最强信号）


# =================================================================
# 80% 高置信度过滤（v1.3 新增）
# =================================================================
@dataclass
class Winrate80Result:
    """80% 高置信度评估结果（比 75% 更严）。"""
    meets: bool
    met_conditions: List[str]
    best_signal: str
    best_signal_winrate: float
    expected_winrate: float
    rejected_75_conditions: List[str]  # 在 75% 触发但 80% 未触发的条件


def meets_winrate_75_conditions(
    team_a: TeamRating,
    team_b: TeamRating,
    series_type: Optional[int] = None,
    top_n: int = 10,  # 用 Top 10 还是 Top 5
    tier_a: Optional[int] = None,
    tier_b: Optional[int] = None,
    tier_elo_a: Optional[float] = None,
    tier_elo_b: Optional[float] = None,
    tier_games_a: int = 0,
    tier_games_b: int = 0,
) -> Winrate75Result:
    """实战 75% 胜率条件。

    数据驱动的条件（9011 场职业比赛 + 选手数据，2026-09-15 更新）：

    ┌──────────────────────────────────────────────────────────┐
    │ 条件                                       胜率     样本     │
    │ ─────────────────────────────────────────────────────── │
    │ ⭐ Top 阵容 (roster≥1700) + 差 ≥ 200         92%+   (v1.3)│
    │ ⭐ BO1 + 阵容压制 (roster 差 ≥ 250)          90%+   (v1.3)│
    │   阵容压制 (roster 差 ≥ 300)                  88%+   (v1.3)│
    │ ★ BO1 + Elo 差 ≥ 200                       95.8%    24    │  v1.4 校准
    │ ★ BO1 + Elo 差 ≥ 170（v1.4 从 150 上调）    92.9%    28    │  v1.4 校准
    │ ★ Top 5 + Elo 差 ≥ 150 + 高状态            88.1%    42    │
    │   差距 200-250                             83.0%    53    │  v1.4 校准
    │   Top 20 强队 + Elo 差 ≥ 200               81.8%    55    │  v1.4 校准
    │   近 10 场胜率 ≥ 70% + 差 ≥ 200            84.2%    19    │
    └──────────────────────────────────────────────────────────┘

    v1.3 新增 roster 维度：
    - 当 strong team roster_avg_elo ≥ 1700 → 视为"Top 阵容"
    - 当两队 roster 差 ≥ 250/300 → 视为"阵容压制"
    - 这两个条件让"明星选手"和"老带新"也能识别

    返回 Winrate75Result：
    - meets: 是否触发"75% 实战胜率"信号
    - met_conditions: 命中的所有条件（用于 UI 展示）
    - best_signal: 单一最强信号
    - expected_winrate: 该信号的历史胜率
    """
    # v1.3 重构：所有条件构建逻辑下沉到 _build_conditions
    conditions = _build_conditions(
        team_a, team_b, series_type,
        tier_a=tier_a, tier_b=tier_b,
        tier_elo_a=tier_elo_a, tier_elo_b=tier_elo_b,
        tier_games_a=tier_games_a, tier_games_b=tier_games_b,
    )

    if not conditions:
        return Winrate75Result(
            meets=False,
            met_conditions=[],
            best_signal="无",
            best_signal_winrate=0.0,
            expected_winrate=0.0,
        )

    # 取最强信号
    best = max(conditions, key=lambda c: c[1])
    return Winrate75Result(
        meets=True,
        met_conditions=[c[0] for c in conditions],
        best_signal=best[0],
        best_signal_winrate=best[1],
        expected_winrate=best[1],
    )


# =================================================================
# 80% 高置信度过滤（v1.3 新增）
# =================================================================
def _build_conditions(
    team_a: TeamRating,
    team_b: TeamRating,
    series_type: Optional[int],
    tier_a: Optional[int] = None,
    tier_b: Optional[int] = None,
    tier_elo_a: Optional[float] = None,
    tier_elo_b: Optional[float] = None,
    tier_games_a: int = 0,
    tier_games_b: int = 0,
) -> list:
    """内部：构建所有条件 [(描述, 历史胜率)]。

    v1.6 混合方案：
    - 同层（tier_gap=0）：用 raw team_elo + tier_offset（保持 v1.5 数值）
    - 跨层（tier_gap ≥ 1）：用 per-tier Elo + 收缩（解决 v1.5 的方向错误问题）
    """
    tier_gap = abs((tier_a or 3) - (tier_b or 3)) if (tier_a and tier_b) else 0
    use_per_tier = tier_gap > 0 and tier_elo_a is not None and tier_elo_b is not None
    if use_per_tier:
        # 跨层：per-tier + 半强度 offset
        elo_a = apply_bayesian_shrinkage(tier_elo_a, tier_games_a)
        elo_a += tier_elo_offset(tier_a) * 0.5
        elo_b = apply_bayesian_shrinkage(tier_elo_b, tier_games_b)
        elo_b += tier_elo_offset(tier_b) * 0.5
    else:
        elo_a = apply_bayesian_shrinkage(team_a.team_elo, team_a.games)
        elo_a += tier_elo_offset(tier_a)
        elo_b = apply_bayesian_shrinkage(team_b.team_elo, team_b.games)
        elo_b += tier_elo_offset(tier_b)
    gap = abs(elo_a - elo_b)
    if elo_a >= elo_b:
        strong, weak = team_a, team_b
    else:
        strong, weak = team_b, team_a

    # 强队近 10 场胜率
    recent_wr = None
    if strong.recent_results:
        n = min(len(strong.recent_results), 10)
        recent_wr = sum(strong.recent_results[:n]) / n

    # roster 维度
    def _roster_avg(team: TeamRating):
        if not team.player_elo:
            return None
        return sum(team.player_elo.values()) / len(team.player_elo)

    strong_roster = _roster_avg(strong)
    weak_roster = _roster_avg(weak)
    roster_gap = (strong_roster - weak_roster) if (strong_roster and weak_roster) else None

    is_bo1 = series_type == 0
    conditions = []

    # 条件 1: 强队 + 差 ≥ 200
    if gap >= ELO_DIFF_THRESHOLD and strong.games >= 30:
        if strong.games >= 100:
            conditions.append((f"顶尖强队（{strong.games} 场）+ Elo 差 {gap:.0f}", 0.844))
        elif strong.games >= 50:
            conditions.append((f"Top 10 强队 + Elo 差 {gap:.0f}", 0.844))
        elif strong.games >= 30:
            conditions.append((f"Top 20 强队 + Elo 差 {gap:.0f}", 0.848))

    # 条件 2: BO1 + 差 ≥ 200
    if is_bo1 and gap >= ELO_DIFF_THRESHOLD:
        conditions.append((f"BO1 + Elo 差 {gap:.0f}", 0.955))

    # 条件 3: BO1 + 差 ≥ 170（v1.4 上调：150-170 历史 WR 仅 64%，170+ 92%）
    if is_bo1 and 170 <= gap < ELO_DIFF_THRESHOLD:
        conditions.append((f"BO1 + Elo 差 {gap:.0f} (>= 170)", 0.92))

    # 条件 4: 高近期胜率
    if recent_wr is not None and recent_wr >= 0.7 and gap >= ELO_DIFF_THRESHOLD:
        conditions.append((f"近 10 场 {recent_wr * 100:.0f}% 胜率 + Elo 差 {gap:.0f}", 0.842))

    # 条件 5: Top 5 + 高状态
    if (gap >= 150 and recent_wr is not None and recent_wr >= 0.7
            and strong.games >= 100):
        conditions.append((f"Top 5 强队 + Elo 差 {gap:.0f} + 高状态", 0.881))

    # 条件 6: 差距 200-250
    if 200 <= gap < 250:
        conditions.append((f"Elo 差 200-250 区间", 0.871))

    # 条件 7: Top 阵容
    if strong_roster is not None and strong_roster >= 1700 and gap >= ELO_DIFF_THRESHOLD:
        conditions.append((f"Top 阵容（roster {strong_roster:.0f}）+ Elo 差 {gap:.0f}", 0.92))

    # 条件 8: BO1 + 阵容压制
    if roster_gap is not None and roster_gap >= 250 and is_bo1:
        conditions.append((f"BO1 + 阵容压制（roster 差 {roster_gap:.0f}）", 0.90))

    # 条件 9: 阵容压制
    if roster_gap is not None and roster_gap >= 300:
        conditions.append((f"阵容压制（roster 差 {roster_gap:.0f}）", 0.88))

    return conditions


def meets_winrate_80_conditions(
    team_a: TeamRating,
    team_b: TeamRating,
    series_type: Optional[int] = None,
    tier_a: Optional[int] = None,
    tier_b: Optional[int] = None,
    tier_elo_a: Optional[float] = None,
    tier_elo_b: Optional[float] = None,
    tier_games_a: int = 0,
    tier_games_b: int = 0,
) -> Winrate80Result:
    """80% 高置信度过滤（v1.3 新增）。

    比 75% 更严格：只返回历史胜率 ≥ 80% 的条件。
    适用场景：宁可少下注/少预测，命中率更高。

    80%+ 条件清单（基于 1000 场实战回测）：
    ┌────────────────────────────────────────────────────────┐
    │ 条件                                  胜率     样本      │
    │ ──────────────────────────────────────────────────────  │
    │ ★ BO1 + Elo 差 ≥ 200                95.5%    22         │
    │ ★ Top 阵容 + Elo 差 ≥ 200          92%      (v1.3)    │
    │ ★ BO1 + 阵容压制                    90%      (v1.3)    │
    │ ★ Top 5 + 差 150+ + 高状态         88.1%    42         │
    │   阵容压制 (roster 差 300+)         88%      (v1.3)    │
    │   差距 200-250                       87.1%    31         │
    │   Top 20 + 差 200+                   84.8%    33         │
    │   Top 5/10 + 差 200+                84.4%    32         │
    │   近 10 场 70% + 差 200+            84.2%    19         │
    │   Top 5 + 高状态                     83.3%    18         │
    │   BO1 + 差 150-199                   82.1%    78         │
    │   差距 150-200                       80.7%    88         │
    └────────────────────────────────────────────────────────┘

    返回 Winrate80Result：
    - meets: 是否触发
    - rejected_75_conditions: 在 75% 触发但 80% 未触发的条件
    """
    # 先拿全部条件（按胜率降序）
    all_conditions = _build_conditions(
        team_a, team_b, series_type,
        tier_a=tier_a, tier_b=tier_b,
        tier_elo_a=tier_elo_a, tier_elo_b=tier_elo_b,
        tier_games_a=tier_games_a, tier_games_b=tier_games_b,
    )
    # 过滤到 ≥ 80%
    high_conditions = [(d, w) for d, w in all_conditions if w >= 0.80]
    low_conditions = [(d, w) for d, w in all_conditions if 0.75 <= w < 0.80]

    if not high_conditions:
        return Winrate80Result(
            meets=False,
            met_conditions=[],
            best_signal="无",
            best_signal_winrate=0.0,
            expected_winrate=0.0,
            rejected_75_conditions=[d for d, _ in low_conditions],
        )

    best = max(high_conditions, key=lambda c: c[1])
    return Winrate80Result(
        meets=True,
        met_conditions=[d for d, _ in high_conditions],
        best_signal=best[0],
        best_signal_winrate=best[1],
        expected_winrate=best[1],
        rejected_75_conditions=[d for d, _ in low_conditions],
    )


# =================================================================
# Upset risk 调整
# =================================================================
UPSET_RISK = {
    "new_patch_week": 20,
    "roster_change": 20,
    "hidden_pool": 15,
    "bo1": 25,
    "underdog_streak": 15,
}


def upset_risk_points(
    favorite_is_favorite: bool,
    series_type: Optional[int] = None,
    new_patch_week: bool = False,
    favorite_roster_change: bool = False,
    favorite_hidden_pool: bool = False,
    underdog_win_streak: bool = False,
) -> int:
    """计算 upset 风险总分。"""
    risk = 0
    if new_patch_week:
        risk += UPSET_RISK["new_patch_week"]
    if favorite_roster_change:
        risk += UPSET_RISK["roster_change"]
    if favorite_hidden_pool:
        risk += UPSET_RISK["hidden_pool"]
    if series_type == 0:  # BO1
        risk += UPSET_RISK["bo1"]
    if underdog_win_streak:
        risk += UPSET_RISK["underdog_streak"]
    return risk


def upset_adjusted_prob(
    team_a: TeamRating,
    team_b: TeamRating,
    risk_points: int,
    patch: Optional[str] = None,
    draft_adv_a: float = 0.0,
    draft_adv_b: float = 0.0,
    weights: Weights = DEFAULT_WEIGHTS,
) -> float:
    """upset 调整后的胜率：给 B 加 risk_points 分。"""
    ra = composite_rating(team_a, patch, weights) + draft_adv_a
    rb = composite_rating(team_b, patch, weights) + draft_adv_b + risk_points
    return expected_win(ra, rb)
