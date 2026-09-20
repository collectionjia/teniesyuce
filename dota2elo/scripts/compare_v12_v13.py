"""
v1.2 vs v1.3 回测对比

对比维度：
1. 整体 log_loss / Brier
2. HC@75 命中率
3. Top 5/10 内战准确率
4. 冷门率（upset rate）

v1.2：只用 team_elo（logistic 公式）
v1.3：composite_rating 用 真实 player_elo + 真 opponent Elo
"""
import sys
import os
import math
from collections import defaultdict
from bisect import bisect_left
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match, RatingHistory, Team, Player, PlayerMatchStat
from dota2elo.elo import (
    expected_win, predict, TeamRating,
    meets_winrate_75_conditions, ELO_DIFF_THRESHOLD,
)
from dota2elo.calibration import get_calibration
from dota2elo.roster import get_current_roster


def get_match_elo(s, team_id, before_match_id):
    r = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).first()
    if r:
        return r.elo_after
    t = s.get(Team, team_id)
    return t.rating if t else 1500.0


def run_backtest(use_player_elo: bool = True, limit: int = None):
    """回测。"""
    cal = get_calibration()
    results = {
        "n": 0,
        "log_loss": 0.0,
        "brier": 0.0,
        "n_qualified_75": 0,
        "n_correct_75": 0,
        "n_top10_vs_top10": 0,
        "n_correct_top10": 0,
        "n_upset": 0,
        "eps": 1e-9,
    }

    # 缓存 team_elo 序列
    print(f"  use_player_elo={use_player_elo}")

    # 收集所有比赛 + 双方历史（roster）
    with session_scope() as s:
        # Top 10 队 ID
        top10_ids = {t.id for t in s.query(Team).order_by(Team.rating.desc()).limit(10).all()}

        # 加载所有 PlayerMatchStat 按 match_id 索引
        all_pms = s.query(PlayerMatchStat).order_by(PlayerMatchStat.match_id).all()
        pms_by_match = defaultdict(list)
        for pms in all_pms:
            pms_by_match[pms.match_id].append(pms)

        # 加载所有比赛 - materialize 成 dict 避免 detached instance
        q = s.query(Match).filter(
            Match.radiant_win.isnot(None),
            Match.radiant_team_id.isnot(None),
            Match.dire_team_id.isnot(None),
        )
        if limit:
            q = q.order_by(Match.start_time.desc()).limit(limit)
        else:
            q = q.order_by(Match.start_time)
        matches_data = [{
            "match_id": m.match_id,
            "radiant_team_id": m.radiant_team_id,
            "dire_team_id": m.dire_team_id,
            "radiant_win": bool(m.radiant_win),
            "start_time": m.start_time,
        } for m in q.all()]

    # 如果用 player_elo，需要按时间正序处理以保持"赛前"语义
    if use_player_elo:
        matches_data = sorted(matches_data, key=lambda m: m["start_time"])

    print(f"  matches: {len(matches_data)}")

    for m in matches_data:
        with session_scope() as s:
            ra = get_match_elo(s, m["radiant_team_id"], m["match_id"])
            rb = get_match_elo(s, m["dire_team_id"], m["match_id"])
            if ra is None or rb is None:
                continue

            # roster（赛前）
            roster_a = {}
            roster_b = {}
            if use_player_elo:
                roster_a = get_current_roster(m["radiant_team_id"], lookback_matches=5)
                roster_b = get_current_roster(m["dire_team_id"], lookback_matches=5)

            team_a = TeamRating(
                team_id=m["radiant_team_id"], team_elo=ra, games=10,
                player_elo=roster_a,
            )
            team_b = TeamRating(
                team_id=m["dire_team_id"], team_elo=rb, games=10,
                player_elo=roster_b,
            )

            # 4 维预测
            p_4d, _ = predict(team_a, team_b)

            # favorite = Elo 高的一方
            if ra >= rb:
                fav_is_radiant = True
            else:
                fav_is_radiant = False
            fav_won = m["radiant_win"] if fav_is_radiant else not m["radiant_win"]
            # favorite 的胜率（从 4 维里取）
            p_fav_score = p_4d if fav_is_radiant else (1 - p_4d)
            # 用于判断准确率的胜率（总是按 Elo 高的那方）
            p_for_correct = p_4d if ra >= rb else (1 - p_4d)

            actual_fav = 1.0 if fav_won else 0.0
            eps = results["eps"]
            results["log_loss"] -= (actual_fav * math.log(max(p_fav_score, eps)) +
                                    (1 - actual_fav) * math.log(max(1 - p_fav_score, eps)))
            results["brier"] += (p_fav_score - actual_fav) ** 2

            # 75% 条件
            wr75 = meets_winrate_75_conditions(team_a, team_b, series_type=1)
            if wr75.meets:
                results["n_qualified_75"] += 1
                if (p_fav_score > 0.5) == fav_won:
                    results["n_correct_75"] += 1

            # Top 10 内战
            if m["radiant_team_id"] in top10_ids and m["dire_team_id"] in top10_ids:
                results["n_top10_vs_top10"] += 1
                if (p_for_correct > 0.5) == m["radiant_win"]:
                    results["n_correct_top10"] += 1

            # 冷门
            if (p_for_correct > 0.5) != m["radiant_win"]:
                results["n_upset"] += 1

            results["n"] += 1

    n = max(1, results["n"])
    return {
        "n": results["n"],
        "log_loss": results["log_loss"] / n,
        "brier": results["brier"] / n,
        "qualified_75_count": results["n_qualified_75"],
        "qualified_75_rate": results["n_qualified_75"] / n,
        "qualified_75_accuracy": (results["n_correct_75"] / results["n_qualified_75"]
                                 if results["n_qualified_75"] else None),
        "top10_vs_top10_count": results["n_top10_vs_top10"],
        "top10_vs_top10_accuracy": (results["n_correct_top10"] / results["n_top10_vs_top10"]
                                   if results["n_top10_vs_top10"] else None),
        "upset_rate": results["n_upset"] / n,
    }


def main():
    print("=" * 60)
    print("  v1.2 vs v1.3 回测对比")
    print("=" * 60)
    print()

    print("=== v1.2 (只用 team_elo) ===")
    r12 = run_backtest(use_player_elo=False, limit=1000)
    for k, v in r12.items():
        print(f"  {k}: {v}")
    print()

    print("=== v1.3 (composite + player_elo) ===")
    r13 = run_backtest(use_player_elo=True, limit=1000)
    for k, v in r13.items():
        print(f"  {k}: {v}")
    print()

    print("=== 对比 ===")
    if r12["n"] > 0 and r13["n"] > 0:
        print(f"  log_loss:    {r12['log_loss']:.4f} → {r13['log_loss']:.4f}  "
              f"(Δ={r13['log_loss']-r12['log_loss']:+.4f})")
        print(f"  Brier:       {r12['brier']:.4f} → {r13['brier']:.4f}  "
              f"(Δ={r13['brier']-r12['brier']:+.4f})")
        if r12["qualified_75_accuracy"] and r13["qualified_75_accuracy"]:
            print(f"  HC@75 命中率:  {r12['qualified_75_accuracy']*100:.1f}% → "
                  f"{r13['qualified_75_accuracy']*100:.1f}%  "
                  f"(Δ={(r13['qualified_75_accuracy']-r12['qualified_75_accuracy'])*100:+.1f}pp)")
        if r12["top10_vs_top10_accuracy"] and r13["top10_vs_top10_accuracy"]:
            print(f"  Top10 内战:  {r12['top10_vs_top10_accuracy']*100:.1f}% → "
                  f"{r13['top10_vs_top10_accuracy']*100:.1f}%  "
                  f"(Δ={(r13['top10_vs_top10_accuracy']-r12['top10_vs_top10_accuracy'])*100:+.1f}pp)")
        print(f"  触发数:      {r12['qualified_75_count']} → {r13['qualified_75_count']}")


if __name__ == "__main__":
    main()
