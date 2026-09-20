"""
黄金指标 HC@75 实现 + 验证（v1.2 重定义）。

定义：当 `meets_winrate_75_conditions` 触发时，模型的预测命中率。

历史定义 v1.0-v1.1：校准胜率 ≥ 0.85 时命中率
问题：v1.2 数据下最大 Elo 差只有 260，logistic 最高 81.7%，永远触发不了 85%。

v1.2 重定义：改用数据驱动的 75% 胜率条件（已在 elo.py 实现）。
优势：
- 不依赖具体阈值（条件本身已经过回测验证）
- 在新数据下有足够样本（30+ 场触发）
- 与"实战 75% 胜率"语义一致

详见 ARCHITECTURE.md / docs/HC85_SPEC.md
"""
import sys
import os
import json
import math
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import List, Literal
from bisect import bisect_left
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match, RatingHistory, Team
from dota2elo.calibration import get_calibration
from dota2elo.elo import (
    meets_winrate_75_conditions, TeamRating,
    ELO_DIFF_THRESHOLD,
)


# =================================================================
# 数据结构
# =================================================================
@dataclass
class HistoricalMatch:
    match_id: int
    start_time: datetime
    team_a_id: int
    team_b_id: int
    elo_a_before: float
    elo_b_before: float
    actual_winner: Literal["A", "B"]
    series_type: str  # "bo1" / "bo3" / "bo5"


@dataclass
class HC85Bucket:
    label: str
    n: int
    n_qualified: int
    accuracy: float
    qualified_rate: float


@dataclass
class HC85Result:
    metric_name: str
    n_total: int
    n_qualified: int
    qualified_rate: float
    accuracy: float
    baseline_accuracy: float
    lift: float
    log_loss: float
    brier: float
    by_gap: List[HC85Bucket] = field(default_factory=list)
    by_month: List[HC85Bucket] = field(default_factory=list)
    by_league: List[HC85Bucket] = field(default_factory=list)
    by_signal: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "metric_name": self.metric_name,
            "n_total": self.n_total,
            "n_qualified": self.n_qualified,
            "qualified_rate": round(self.qualified_rate, 4),
            "accuracy": round(self.accuracy, 4),
            "baseline_accuracy": round(self.baseline_accuracy, 4),
            "lift": round(self.lift, 4),
            "log_loss": round(self.log_loss, 4),
            "brier": round(self.brier, 4),
            "by_gap": [asdict(b) for b in self.by_gap],
            "by_month": [asdict(b) for b in self.by_month],
            "by_league": [asdict(b) for b in self.by_league],
            "by_signal": self.by_signal,
        }


# =================================================================
# 数据加载
# =================================================================
def load_matches() -> List[HistoricalMatch]:
    """从 DB 加载所有比赛 + 双方 Elo + series_type。"""
    matches = []
    with session_scope() as s:
        history = s.query(RatingHistory).order_by(RatingHistory.match_id).all()
        hist_by_team: dict = {}
        for h in history:
            hist_by_team.setdefault(h.team_id, []).append((h.match_id, h.elo_after))

        db_matches = s.query(Match).filter(Match.radiant_win.isnot(None)).all()
        for m in db_matches:
            elo_a = _lookup_elo_before(hist_by_team.get(m.radiant_team_id, []), m.match_id)
            elo_b = _lookup_elo_before(hist_by_team.get(m.dire_team_id, []), m.match_id)
            if elo_a is None or elo_b is None:
                continue
            matches.append(HistoricalMatch(
                match_id=m.match_id,
                start_time=m.start_time,
                team_a_id=m.radiant_team_id,
                team_b_id=m.dire_team_id,
                elo_a_before=elo_a,
                elo_b_before=elo_b,
                actual_winner="A" if m.radiant_win else "B",
                series_type=m.series_type or "unknown",
            ))
    return matches


def _lookup_elo_before(records, match_id):
    if not records:
        return None
    ids = [r[0] for r in records]
    idx = bisect_left(ids, match_id) - 1
    if idx < 0:
        return None
    return records[idx][1]


# =================================================================
# 核心算法：HC@75（基于 meets_winrate_75_conditions）
# =================================================================
def compute_hc75(matches: List[HistoricalMatch]) -> HC85Result:
    """计算 HC@75 黄金指标（v1.2 重定义）。

    触发条件：meets_winrate_75_conditions(team_a, team_b, series_type) 为 True
    """
    matches = sorted(matches, key=lambda m: m.start_time)
    qualified: List[tuple] = []
    all_correct = 0
    eps = 1e-9
    log_loss_sum = 0.0
    brier_sum = 0.0

    by_gap: dict = defaultdict(list)
    by_month: dict = defaultdict(list)
    by_league: dict = defaultdict(list)
    by_signal: dict = defaultdict(lambda: {"n": 0, "correct": 0, "wr": 0.0})

    with session_scope() as s:
        league_map = {m.match_id: m.league_name for m in s.query(Match).all()}

    for m in matches:
        elo_a, elo_b = m.elo_a_before, m.elo_b_before
        elo_diff = abs(elo_a - elo_b)
        series_int = {"bo1": 0, "bo3": 1, "bo5": 2}.get(m.series_type, 1)

        # 构造 TeamRating
        team_a_obj = TeamRating(team_id=m.team_a_id, team_elo=elo_a, games=100)
        team_b_obj = TeamRating(team_id=m.team_b_id, team_elo=elo_b, games=100)
        wr75 = meets_winrate_75_conditions(team_a_obj, team_b_obj, series_type=series_int)

        # 强队 = Elo 高的那一方
        if elo_a >= elo_b:
            fav_is_a = True
        else:
            fav_is_a = False
        fav_won = (
            (m.actual_winner == "A" and fav_is_a) or
            (m.actual_winner == "B" and not fav_is_a)
        )
        if fav_won:
            all_correct += 1
        actual_fav = 1.0 if fav_won else 0.0

        # 期望胜率：logistic
        p_fav = 1.0 / (1.0 + 10 ** (-elo_diff / 400.0)) if fav_is_a else 1.0 / (1.0 + 10 ** (elo_diff / 400.0))
        log_loss_sum -= (actual_fav * math.log(max(p_fav, eps)) +
                         (1 - actual_fav) * math.log(max(1 - p_fav, eps)))
        brier_sum += (p_fav - actual_fav) ** 2

        gap_bucket = int(elo_diff // 50) * 50
        month = m.start_time.strftime("%Y-%m") if m.start_time else "unknown"
        league = league_map.get(m.match_id, "Unknown") or "Unknown"

        if wr75.meets:
            qualified.append((p_fav, fav_won, elo_diff, month, gap_bucket, league, wr75.best_signal))
            by_gap[gap_bucket].append((p_fav, fav_won))
            by_month[month].append((p_fav, fav_won))
            by_league[league].append((p_fav, fav_won))
            by_signal[wr75.best_signal]["n"] += 1
            if fav_won:
                by_signal[wr75.best_signal]["correct"] += 1

    n_total = len(matches)
    n_qualified = len(qualified)
    baseline_accuracy = all_correct / n_total if n_total else 0.0

    if n_qualified == 0:
        return HC85Result(
            metric_name="HC@75 (v1.2)",
            n_total=n_total, n_qualified=0, qualified_rate=0.0,
            accuracy=0.0, baseline_accuracy=baseline_accuracy,
            lift=0.0 - baseline_accuracy, log_loss=0.0, brier=0.0,
        )

    n_correct = sum(1 for _, won, *_ in qualified if won)
    accuracy = n_correct / n_qualified
    lift = accuracy - baseline_accuracy

    q_log_loss = sum(
        -(actual * math.log(max(p, eps)) + (1 - actual) * math.log(max(1 - p, eps)))
        for p, won, *_ in qualified
        for actual in [1.0 if won else 0.0]
    ) / n_qualified
    q_brier = sum((p - (1.0 if won else 0.0)) ** 2 for p, won, *_ in qualified) / n_qualified

    # 计算每个 signal 的胜率
    for sig, data in by_signal.items():
        if data["n"] > 0:
            data["wr"] = data["correct"] / data["n"]

    return HC85Result(
        metric_name="HC@75 (v1.2, meets_winrate_75_conditions 触发)",
        n_total=n_total,
        n_qualified=n_qualified,
        qualified_rate=n_qualified / n_total,
        accuracy=accuracy,
        baseline_accuracy=baseline_accuracy,
        lift=lift,
        log_loss=q_log_loss,
        brier=q_brier,
        by_gap=_bucket_summary(by_gap, qualified=True),
        by_month=_bucket_summary(by_month, qualified=True),
        by_league=_bucket_summary(by_league, qualified=True),
        by_signal=dict(by_signal),
    )


def _bucket_summary(bucket_data: dict, qualified: bool):
    """聚合分桶统计。
    - qualified=True: 输入已经预筛过（只包含 qualified matches）
    - qualified=False: 用 p>=0.85 筛
    """
    out = []
    for key, items in bucket_data.items():
        n = len(items)
        if qualified:
            # 输入就是 qualified 子集
            n_qual = n
            correct = sum(1 for _, won in items if won)
        else:
            n_qual = sum(1 for p, _ in items if p >= 0.85)
            correct = sum(1 for p, won in items if p >= 0.85 and won)
        acc = correct / n_qual if n_qual else 0.0
        if isinstance(key, int):
            label = f"{key}-{key + 50}"
        else:
            label = str(key)
        out.append(HC85Bucket(
            label=label, n=n, n_qualified=n_qual,
            accuracy=acc, qualified_rate=n_qual / n if n else 0.0,
        ))
    out.sort(key=lambda b: b.label)
    return out


# =================================================================
# 入口
# =================================================================
def main():
    print("加载数据...")
    matches = load_matches()
    print(f"  总比赛数: {len(matches)}")

    print("计算 HC@75 (v1.2)...")
    result = compute_hc75(matches)
    print()

    print("=" * 60)
    print("  HC@75 黄金指标（v1.2 重定义）")
    print("=" * 60)
    print(f"  指标名:        {result.metric_name}")
    print(f"  总样本:        {result.n_total} 场")
    print(f"  触发 75% 条件: {result.n_qualified} 场  ({result.qualified_rate * 100:.2f}%)")
    print(f"  命中率:        {result.accuracy * 100:.1f}%  ({int(result.accuracy * result.n_qualified)}/{result.n_qualified})")
    print(f"  基线准确率:    {result.baseline_accuracy * 100:.1f}%")
    print(f"  提升幅度:      {result.lift * 100:+.1f} pp")
    print(f"  log_loss:      {result.log_loss:.4f}")
    print(f"  Brier:         {result.brier:.4f}")
    print()

    if result.accuracy >= 0.85:
        status = "🟢 健康"
    elif result.accuracy >= 0.80:
        status = "🟡 关注"
    elif result.accuracy >= 0.70:
        status = "🟠 警告"
    else:
        status = "🔴 严重"
    print(f"  状态:          {status}")
    print()

    # 按信号分组（聚合相似信号）
    print("=== 按触发信号（聚合）===")
    print(f"  {'信号类别':<45} {'样本':>6} {'命中':>6} {'命中率':>8}")

    # 信号聚合：把"BO1 + Elo 差 152 (>= 150)"统一为"BO1 + Elo 差 150-199"
    def categorize_signal(sig: str) -> str:
        if "BO1 + Elo 差" in sig:
            if "(>= 150)" in sig:
                return "BO1 + Elo 差 150-199"
            else:
                return "BO1 + Elo 差 200+"
        if "顶尖强队" in sig or "Top 10 强队" in sig:
            return "Top 强队 + Elo 差 200+"
        if "Top 20 强队" in sig:
            return "Top 20 强队 + Elo 差 200+"
        if "近 10 场" in sig:
            return "近 10 场高胜率 + Elo 差 200+"
        if "Top 5 强队 + Elo 差" in sig and "高状态" in sig:
            return "Top 5 + 差 150+ + 高状态"
        if "Elo 差 200-250" in sig:
            return "Elo 差 200-250 区间"
        return sig

    agg = defaultdict(lambda: {"n": 0, "correct": 0})
    for sig, data in result.by_signal.items():
        cat = categorize_signal(sig)
        agg[cat]["n"] += data["n"]
        agg[cat]["correct"] += data["correct"]

    sorted_cats = sorted(agg.items(), key=lambda x: -x[1]["n"])
    for cat, data in sorted_cats:
        if data["n"] == 0:
            continue
        wr = data["correct"] / data["n"]
        print(f"  {cat:<45} {data['n']:>6} {data['correct']:>6} {wr*100:>7.1f}%")
    print()

    # 按 Elo 差分桶（只统计 qualified）
    print("=== 按 Elo 差分桶（仅 qualified）===")
    print(f"  {'区间':<12} {'触发':>6} {'命中率':>8}")
    for b in result.by_gap:
        if b.n_qualified == 0:
            continue
        print(f"  {b.label:<12} {b.n_qualified:>6} {b.accuracy * 100:>7.1f}%")
    print()

    # 按月
    print("=== 按月分桶（最近 12 个月，仅 qualified）===")
    print(f"  {'月份':<10} {'触发':>6} {'命中率':>8}")
    for b in result.by_month[-12:]:
        if b.n_qualified == 0:
            continue
        print(f"  {b.label:<10} {b.n_qualified:>6} {b.accuracy * 100:>7.1f}%")
    print()

    # JSON
    out_file = "data/hc85_result.json"
    with open(out_file, "w") as f:
        json.dump(result.to_dict(), f, indent=2, ensure_ascii=False, default=str)
    print(f"完整结果: {out_file}")


if __name__ == "__main__":
    main()
