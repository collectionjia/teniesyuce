"""
Elo 差驱动的概率校准。

为什么需要：
- 纯 logistic 公式 1/(1+10^(-Δ/400)) 在 Dota 实战中**普遍偏自信**
- 200-300 Elo 差时模型说 80%，实际只有 70%（10% 偏自信）
- 1000+ Elo 差模型说 99%，实际可能 95%
- 校准的本质：把"模型的预测"映射到"实战中的实际频率"

设计：
- 训练数据：所有有双方 Elo 历史的比赛
- 特征：|ΔElo| 与胜者关系 → 实际胜率
- 输出：一个分段表，预测时按 Elo 差查表
- 不写死桶，**用 Elo 差自身做分桶轴**

校准表落盘到 data/calibration.json，recalibrate 时重建。
"""
from __future__ import annotations
import json
import math
import os
import statistics
from bisect import bisect_left
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import session_scope
from .config import DB_PATH
from .models import Match, RatingHistory, Team


CALIBRATION_FILE = DB_PATH.parent / "calibration.json"


# =================================================================
# 数据结构
# =================================================================
@dataclass
class CalibrationPoint:
    """一个 (ΔElo, 实际胜率) 数据点。"""
    elo_diff: float       # |ΔElo|，> 0
    favorite_won: bool    # Elo 高的一方是否赢
    p_predicted: float    # 模型原本的预测胜率（logistic）

    @property
    def bucket(self) -> int:
        """分桶：每 50 Elo 一桶。"""
        return int(self.elo_diff // 50) * 50


@dataclass
class CalibrationBucket:
    """聚合后的桶：区间 + 实际胜率 + 校准后概率。"""
    elo_lo: float          # 区间下界（含）
    elo_hi: float          # 区间上界（不含）
    sample_size: int       # 样本数
    actual_win_rate: float # 实际频率
    raw_p_win: float       # logistic 期望胜率（按区间中点算）
    calibrated_p_win: float  # 校准后胜率（带平滑）

    @property
    def bias(self) -> float:
        """> 0 偏保守，< 0 偏自信。"""
        return self.actual_win_rate - self.raw_p_win


# =================================================================
# 校准模型
# =================================================================
class EloCalibration:
    """基于 Elo 差的概率校准。"""

    BUCKET_SIZE = 50.0  # 每 50 Elo 一桶
    MIN_SAMPLES = 5     # 桶内至少 N 样本才视为可信
    SMOOTHING_WINDOW = 3  # 跨桶平滑窗口（左右各看 N 桶）
    DEFAULT_PRIOR = 0.5  # 缺数据时的默认校准

    def __init__(self):
        self.buckets: List[CalibrationBucket] = []
        self.elo_breaks: List[float] = []  # 桶边界
        self.calibrated_probs: List[float] = []  # 对应校准胜率
        self._loaded = False

    # ---------- 构建校准表 ----------
    def fit(self, session: Session) -> int:
        """从历史比赛数据构建校准表。返回处理的比赛数。"""
        points = self._extract_points(session)
        if not points:
            return 0

        raw_buckets = self._aggregate_buckets(points)
        self.buckets = self._smooth_buckets(raw_buckets)
        self._build_lookup()
        self._loaded = True
        return len(points)

    def _extract_points(self, session: Session) -> List[CalibrationPoint]:
        """从 DB 抽取所有可用比赛 + 计算 Elo 差。"""
        points: List[CalibrationPoint] = []

        # 一次性取所有 RatingHistory（按 match_id 索引方便二分）
        history = session.scalars(
            select(RatingHistory).order_by(RatingHistory.match_id)
        ).all()
        # team_id -> [(match_id, elo_after), ...]（已按 match_id 升序）
        hist_by_team: dict[int, list] = {}
        for h in history:
            hist_by_team.setdefault(h.team_id, []).append((h.match_id, h.elo_after))

        # 取所有已完成比赛
        matches = session.scalars(
            select(Match).where(Match.radiant_win.isnot(None))
        ).all()

        for m in matches:
            if not m.radiant_team_id or not m.dire_team_id:
                continue
            # 找这场比赛发生时两队的最近 Elo
            ra = self._lookup_elo_before(hist_by_team.get(m.radiant_team_id, []), m.match_id)
            rb = self._lookup_elo_before(hist_by_team.get(m.dire_team_id, []), m.match_id)
            if ra is None or rb is None:
                continue

            diff = abs(ra - rb)
            if diff < 1:
                continue
            # favorite = Elo 高的那一方
            if ra > rb:
                favorite_is_radiant = True
                p_fav = 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))
            elif rb > ra:
                favorite_is_radiant = False
                p_fav = 1.0 / (1.0 + 10 ** ((ra - rb) / 400.0))
            else:
                continue

            favorite_won = m.radiant_win if favorite_is_radiant else not m.radiant_win
            points.append(CalibrationPoint(
                elo_diff=diff,
                favorite_won=favorite_won,
                p_predicted=p_fav,
            ))
        return points

    @staticmethod
    def _lookup_elo_before(records: list, match_id: int) -> Optional[float]:
        """二分查找：返回严格 < match_id 的最大 match_id 对应的 elo_after。"""
        if not records:
            return None
        # records 已是升序
        # 找第一个 match_id >= target 的下标，然后 -1
        ids = [r[0] for r in records]
        idx = bisect_left(ids, match_id) - 1
        if idx < 0:
            return None
        return records[idx][1]

    def _aggregate_buckets(self, points: List[CalibrationPoint]) -> List[CalibrationBucket]:
        """按 Elo 差分桶聚合。"""
        bucket_data: dict[int, list[bool]] = {}
        for p in points:
            bucket_data.setdefault(p.bucket, []).append(p.favorite_won)

        buckets = []
        for lo in sorted(bucket_data.keys()):
            wins = bucket_data[lo]
            n = len(wins)
            actual_rate = sum(wins) / n
            mid = lo + self.BUCKET_SIZE / 2
            raw_p = 1.0 / (1.0 + 10 ** (-mid / 400.0))
            buckets.append(CalibrationBucket(
                elo_lo=float(lo),
                elo_hi=float(lo + self.BUCKET_SIZE),
                sample_size=n,
                actual_win_rate=actual_rate,
                raw_p_win=raw_p,
                calibrated_p_win=actual_rate,  # 暂存，平滑时再覆盖
            ))
        return buckets

    def _smooth_buckets(self, buckets: List[CalibrationBucket]) -> List[CalibrationBucket]:
        """对校准胜率做滑动平均平滑，避免小样本噪声。"""
        if not buckets:
            return []
        out = []
        win_rates = [b.actual_win_rate for b in buckets]
        win_n = [b.sample_size for b in buckets]
        for i, b in enumerate(buckets):
            # 取左右各 SMOOTHING_WINDOW 桶的加权平均
            lo_idx = max(0, i - self.SMOOTHING_WINDOW)
            hi_idx = min(len(buckets), i + self.SMOOTHING_WINDOW + 1)
            weighted_sum = 0.0
            total_weight = 0.0
            for j in range(lo_idx, hi_idx):
                # 越近权重越大
                dist = abs(j - i)
                w = 1.0 / (1.0 + dist) * math.sqrt(win_n[j])
                weighted_sum += win_rates[j] * w
                total_weight += w
            smoothed = weighted_sum / total_weight if total_weight > 0 else b.actual_win_rate
            # 限制在 (0.5, 1.0) 区间
            smoothed = max(0.5, min(0.99, smoothed))
            out.append(CalibrationBucket(
                elo_lo=b.elo_lo,
                elo_hi=b.elo_hi,
                sample_size=b.sample_size,
                actual_win_rate=b.actual_win_rate,
                raw_p_win=b.raw_p_win,
                calibrated_p_win=smoothed,
            ))
        return out

    def _build_lookup(self):
        """建立 (elo_diff → calibrated_p) 的快速查表数组。"""
        self.elo_breaks = [b.elo_lo for b in self.buckets] + [self.buckets[-1].elo_hi]
        self.calibrated_probs = [b.calibrated_p_win for b in self.buckets]

    # ---------- 预测时使用 ----------
    def apply(self, elo_diff: float) -> float:
        """输入 Elo 差绝对值，返回校准后的胜率。
        - 缺数据 → DEFAULT_PRIOR
        - 差 < 最小桶 → 用最小桶值
        - 差 > 最大桶 → 用最大桶值
        """
        if not self._loaded:
            self._load_or_default()
        if not self.buckets:
            return self.DEFAULT_PRIOR
        diff = abs(elo_diff)
        # 找第一个 elo_lo > diff 的下标
        idx = bisect_left(self.elo_breaks, diff)
        if idx == 0:
            return self.buckets[0].calibrated_p_win
        if idx >= len(self.buckets):
            return self.buckets[-1].calibrated_p_win
        # 在 [idx-1, idx] 之间线性插值
        lo_break = self.buckets[idx - 1].elo_hi
        hi_break = self.buckets[idx].elo_lo
        if hi_break <= lo_break:
            return self.buckets[idx - 1].calibrated_p_win
        t = (diff - lo_break) / (hi_break - lo_break)
        lo_p = self.buckets[idx - 1].calibrated_p_win
        hi_p = self.buckets[idx].calibrated_p_win
        return lo_p + t * (hi_p - lo_p)

    def _load_or_default(self):
        """从文件加载；没文件就用默认。"""
        if CALIBRATION_FILE.exists():
            try:
                with open(CALIBRATION_FILE) as f:
                    data = json.load(f)
                self.buckets = [CalibrationBucket(**b) for b in data["buckets"]]
                self._build_lookup()
                self._loaded = True
            except Exception:
                self._loaded = False
        else:
            self._loaded = False

    # ---------- 持久化 ----------
    def save(self):
        CALIBRATION_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CALIBRATION_FILE, "w") as f:
            json.dump({
                "version": 1,
                "bucket_size": self.BUCKET_SIZE,
                "smoothing_window": self.SMOOTHING_WINDOW,
                "buckets": [asdict(b) for b in self.buckets],
            }, f, indent=2)

    def load(self) -> bool:
        self._load_or_default()
        return self._loaded

    def summary(self) -> str:
        if not self.buckets:
            return "校准表未构建或为空"
        lines = [
            f"Elo 校准表  桶宽={self.BUCKET_SIZE}  平滑窗口={self.SMOOTHING_WINDOW}",
            f"  {'区间':<14} {'样本':>5} {'实际':>8} {'logistic':>9} {'校准':>8} {'偏差':>8}",
        ]
        for b in self.buckets:
            lines.append(
                f"  {b.elo_lo:>4.0f}-{b.elo_hi:<4.0f}   {b.sample_size:>5} "
                f"{b.actual_win_rate * 100:>7.1f}% {b.raw_p_win * 100:>8.1f}% "
                f"{b.calibrated_p_win * 100:>7.1f}% {b.bias * 100:>+7.1f}%"
            )
        return "\n".join(lines)


# =================================================================
# 全局实例 + CLI 入口
# =================================================================
_instance: Optional[EloCalibration] = None


def get_calibration() -> EloCalibration:
    """单例：第一次访问时自动加载。"""
    global _instance
    if _instance is None:
        _instance = EloCalibration()
        _instance.load()
    return _instance


def recalibrate() -> int:
    """重建校准表，返回处理的比赛数。"""
    global _instance
    _instance = EloCalibration()
    with session_scope() as s:
        n = _instance.fit(s)
    if n > 0:
        _instance.save()
    _instance._loaded = True
    return n


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "show":
        get_calibration().summary()
    else:
        n = recalibrate()
        print(f"校准完成，处理 {n} 场比赛")
        print()
        print(get_calibration().summary())
