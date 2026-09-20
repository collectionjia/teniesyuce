"""
分析 top 20 战队之间的比赛表现。

模式 1 (default): 用当前 rating 做"基线预测"，看对历史比赛的实际准确率
模式 2 (--simulate): 从 1500 重新模拟跑，看模型在 top 内战的自洽性
"""
import sys
import os
import math
import argparse
from collections import Counter
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Team, Match
from dota2elo.elo import expected_win, k_factor


def get_top_teams(session, n=20):
    return session.query(Team).order_by(Team.rating.desc()).limit(n).all()


def predict_with_current_elo(matches, top_ids):
    """模式 1：用每场比赛**发生时**两队的 rating_history 里的 rating_after - 上次更新的 Elo。"""
    from dota2elo.models import RatingHistory

    with session_scope() as s:
        log_loss = 0.0
        brier = 0.0
        correct = 0
        n = 0
        per_league_correct = Counter()
        per_league_total = Counter()
        per_series_correct = Counter()
        per_series_total = Counter()

        for m in matches:
            # 取这场比赛发生时两队最近的 rating
            ra = s.query(RatingHistory).filter(
                RatingHistory.team_id == m["radiant_team_id"],
                RatingHistory.match_id < m["match_id"],
            ).order_by(RatingHistory.match_id.desc()).first()
            rb = s.query(RatingHistory).filter(
                RatingHistory.team_id == m["dire_team_id"],
                RatingHistory.match_id < m["match_id"],
            ).order_by(RatingHistory.match_id.desc()).first()

            # 如果没历史记录，用 Team.rating（最终 Elo）
            rating_a = ra.elo_after if ra else s.query(Team).get(m["radiant_team_id"]).rating
            rating_b = rb.elo_after if rb else s.query(Team).get(m["dire_team_id"]).rating

            p_a = expected_win(rating_a, rating_b)
            actual_a = 1.0 if m["radiant_win"] else 0.0

            eps = 1e-9
            log_loss -= (actual_a * math.log(max(p_a, eps)) + (1 - actual_a) * math.log(max(1 - p_a, eps)))
            brier += (p_a - actual_a) ** 2
            predicted_a = p_a > 0.5
            if predicted_a == m["radiant_win"]:
                correct += 1

            league = m["league_name"] or "Unknown"
            per_league_total[league] += 1
            if predicted_a == m["radiant_win"]:
                per_league_correct[league] += 1

            series = m["series_type"] or "unknown"
            per_series_total[series] += 1
            if predicted_a == m["radiant_win"]:
                per_series_correct[series] += 1

            n += 1

        print(f"=== 模式 1：用当时 Elo 做基线预测 ===")
        print(f"  样本:        {n} 场")
        print(f"  log_loss:    {log_loss / n:.4f}")
        print(f"  Brier:       {brier / n:.4f}")
        print(f"  准确率:      {correct / n * 100:.1f}%   ({correct}/{n})")
        print()
        print(f"  按 series_type:")
        for st in sorted(per_series_total, key=lambda x: -per_series_total[x]):
            t = per_series_total[st]
            c = per_series_correct[st]
            print(f"    {st:<10}  {c / t * 100:.1f}%  ({c}/{t})")
        print()
        print(f"  Top 10 联赛准确率:")
        for lg in sorted(per_league_total, key=lambda x: -per_league_total[x])[:10]:
            t = per_league_total[lg]
            c = per_league_correct[lg]
            print(f"    {lg[:50]:<50}  {c / t * 100:.1f}%  ({c}/{t})")


def predict_with_probability_threshold(matches, top_ids):
    """模式 3：分析 top 20 内战中，预测概率分布与实际胜率的关系。"""
    from dota2elo.models import RatingHistory

    with session_scope() as s:
        # 把所有场次按预测概率分桶
        buckets = [
            (0.50, 0.55, "50-55%"),
            (0.55, 0.60, "55-60%"),
            (0.60, 0.70, "60-70%"),
            (0.70, 0.80, "70-80%"),
            (0.80, 0.90, "80-90%"),
            (0.90, 0.95, "90-95%"),
            (0.95, 1.01, "95-100%"),
        ]
        bucket_data = {label: [] for _, _, label in buckets}

        for m in matches:
            ra = s.query(RatingHistory).filter(
                RatingHistory.team_id == m["radiant_team_id"],
                RatingHistory.match_id < m["match_id"],
            ).order_by(RatingHistory.match_id.desc()).first()
            rb = s.query(RatingHistory).filter(
                RatingHistory.team_id == m["dire_team_id"],
                RatingHistory.match_id < m["match_id"],
            ).order_by(RatingHistory.match_id.desc()).first()
            rating_a = ra.elo_after if ra else s.query(Team).get(m["radiant_team_id"]).rating
            rating_b = rb.elo_after if rb else s.query(Team).get(m["dire_team_id"]).rating

            p_a = expected_win(rating_a, rating_b)
            predicted_a = p_a >= 0.5
            actual_a = m["radiant_win"]
            correct = (predicted_a == actual_a)

            for lo, hi, label in buckets:
                if lo <= p_a < hi:
                    bucket_data[label].append(correct)
                    break

        print()
        print(f"=== 模式 3：预测概率分桶 vs 实际准确率（top 20 内战）===")
        print(f"  {'概率区间':<12} {'样本':>6} {'准确率':>8} {'校准':>8}")
        for lo, hi, label in buckets:
            data = bucket_data[label]
            n = len(data)
            if n == 0:
                continue
            acc = sum(data) / n
            mid = (lo + hi) / 2
            calib = acc - mid  # 正 = 偏自信，负 = 偏保守
            print(f"  {label:<12} {n:>6} {acc * 100:>7.1f}% {calib * 100:>+7.1f}%")


def predict_simulation(matches, top_ids):
    """模式 2：从 1500 重新模拟（看自洽性）"""
    with session_scope() as s:
        current_elo = {tid: 1500.0 for tid in top_ids}
        log_loss = 0.0
        brier = 0.0
        correct = 0
        n = 0
        for m in matches:
            a, b = m["radiant_team_id"], m["dire_team_id"]
            if a not in current_elo or b not in current_elo:
                continue
            ra, rb = current_elo[a], current_elo[b]
            p_a = expected_win(ra, rb)
            actual_a = 1.0 if m["radiant_win"] else 0.0
            eps = 1e-9
            log_loss -= (actual_a * math.log(max(p_a, eps)) + (1 - actual_a) * math.log(max(1 - p_a, eps)))
            brier += (p_a - actual_a) ** 2
            if (p_a > 0.5) == m["radiant_win"]:
                correct += 1
            k = k_factor(series_type={"bo1": 0, "bo3": 1, "bo5": 2}.get(m["series_type"], 1),
                         league_name=m["league_name"])
            from dota2elo.elo import update_ratings
            new_a, new_b, _, _ = update_ratings(ra, rb, actual_a, k)
            current_elo[a] = new_a
            current_elo[b] = new_b
            n += 1
        print()
        print(f"=== 模式 2：从 1500 重跑（模型自洽性）===")
        print(f"  样本:        {n} 场")
        print(f"  log_loss:    {log_loss / n:.4f}")
        print(f"  Brier:       {brier / n:.4f}")
        print(f"  准确率:      {correct / n * 100:.1f}%   ({correct}/{n})")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=20)
    parser.add_argument("--mode", choices=["all", "current", "simulate", "buckets"], default="all")
    args = parser.parse_args()

    # 先把所有数据 material 成 dict（避免 detached instance）
    matches_data = []
    top_info = []
    with session_scope() as s:
        top = get_top_teams(s, args.n)
        top_ids = {t.id for t in top}
        for t in top:
            top_info.append((t.id, t.name, t.rating, t.matches_played))
        matches = s.query(Match).filter(
            Match.radiant_team_id.in_(top_ids),
            Match.dire_team_id.in_(top_ids),
            Match.radiant_win.isnot(None),
        ).order_by(Match.start_time).all()
        for m in matches:
            matches_data.append({
                "match_id": m.match_id,
                "radiant_team_id": m.radiant_team_id,
                "dire_team_id": m.dire_team_id,
                "radiant_win": bool(m.radiant_win),
                "league_name": m.league_name,
                "series_type": m.series_type,
                "start_time": m.start_time,
            })

    print(f"=== Top {args.n} 战队 ===")
    for i, (tid, name, rating, mp) in enumerate(top_info, 1):
        print(f"  {i:>2}. {name:<30}  Elo={rating:>7.1f}  场次={mp}")
    print()
    print(f"=== Top {args.n} 内战：{len(matches_data)} 场 ===\n")

    if args.mode in ("all", "current"):
        predict_with_current_elo(matches_data, top_ids)
    if args.mode in ("all", "simulate"):
        predict_simulation(matches_data, top_ids)
    if args.mode in ("all", "buckets"):
        predict_with_probability_threshold(matches_data, top_ids)

    # 联赛/时间分布
    print()
    print(f"=== Top {args.n} 内战的联赛分布 ===")
    league_count = Counter(m["league_name"] or "Unknown" for m in matches_data)
    for lg, cnt in league_count.most_common(10):
        print(f"  {cnt:>4} 场  {lg}")

    print()
    print(f"=== Top {args.n} 内战的时间分布 ===")
    month_count = Counter(m["start_time"].strftime("%Y-%m") for m in matches_data if m["start_time"])
    for mo, cnt in sorted(month_count.items()):
        print(f"  {mo}  {cnt:>4} 场")


if __name__ == "__main__":
    main()
