"""
分析"一方是 top 20，另一方不是"的比赛。

对比：
- 强队胜率（top 20 队作为强队时）
- 冷门率（top 20 队翻车率）
- 不同 Elo 差距下的准确率
- 强队 vs 弱队 vs 强队 vs 强队的对比
"""
import sys
import os
import math
import argparse
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Team, Match, RatingHistory
from dota2elo.elo import expected_win, k_factor, update_ratings


def get_top_teams(session, n=20):
    return session.query(Team).order_by(Team.rating.desc()).limit(n).all()


def get_match_elo(s, team_id, before_match_id):
    """取这场比赛发生时该队最近一次 Elo。"""
    r = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).first()
    if r:
        return r.elo_after
    t = s.get(Team, team_id)
    return t.rating if t else 1500.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=20)
    args = parser.parse_args()

    with session_scope() as s:
        top = get_top_teams(s, args.n)
        top_ids = {t.id for t in top}
        print(f"=== Top {args.n} 战队 ===")
        for i, t in enumerate(top, 1):
            print(f"  {i:>2}. {t.name:<30}  Elo={t.rating:>7.1f}")
        print()

        # 准备：materialize 比赛
        def materialize(q):
            return [{
                "match_id": m.match_id,
                "radiant_team_id": m.radiant_team_id,
                "dire_team_id": m.dire_team_id,
                "radiant_win": bool(m.radiant_win),
                "league_name": m.league_name,
                "series_type": m.series_type,
                "start_time": m.start_time,
            } for m in q]

        both_matches = materialize(s.query(Match).filter(
            Match.radiant_team_id.in_(top_ids),
            Match.dire_team_id.in_(top_ids),
            Match.radiant_win.isnot(None),
        ).order_by(Match.start_time).all())

        one_matches = materialize(s.query(Match).filter(
            Match.radiant_win.isnot(None),
            ((Match.radiant_team_id.in_(top_ids)) & ~Match.dire_team_id.in_(top_ids)) |
            ((~Match.radiant_team_id.in_(top_ids)) & Match.dire_team_id.in_(top_ids))
        ).order_by(Match.start_time).all())

        none_matches = materialize(s.query(Match).filter(
            ~Match.radiant_team_id.in_(top_ids),
            ~Match.dire_team_id.in_(top_ids),
            Match.radiant_win.isnot(None),
        ).order_by(Match.start_time).all())

        print(f"=== 三类比赛样本 ===")
        print(f"  双方都 top 20:   {len(both_matches):>4} 场")
        print(f"  一方 top 20:     {len(one_matches):>4} 场")
        print(f"  双方都非 top 20: {len(none_matches):>4} 场")
        print(f"  合计:            {len(both_matches) + len(one_matches) + len(none_matches):>4} 场")
        print()

    # === 模式 1: 一方 top 20 时，top 20 队的胜率 ===
    analyze_one_top20(s, one_matches, top_ids)

    # === 模式 2: 三类比赛对比 ===
    compare_three_categories(s, both_matches, one_matches, none_matches, top_ids)

    # === 模式 3: 按 Elo 差距分桶，看预测准确率 ===
    elo_gap_buckets(s, one_matches, top_ids)

    # === 模式 4: 强队作为不同角色时的表现 ===
    analyze_strong_vs_weak(s, one_matches, top_ids)


def analyze_one_top20(s, matches, top_ids):
    """top 20 队在一面时的胜率与翻车率。"""
    print(f"=== 模式 1：Top 20 在一方时的表现 ===")
    n = 0
    top_wins = 0
    log_loss = 0.0
    brier = 0.0
    elo_gaps = []
    correct = 0
    upsets = 0  # 弱队赢

    for m in matches:
        with session_scope() as ss:
            ra = get_match_elo(ss, m["radiant_team_id"], m["match_id"])
            rb = get_match_elo(ss, m["dire_team_id"], m["match_id"])
        is_top_radiant = m["radiant_team_id"] in top_ids
        top_elo = ra if is_top_radiant else rb
        weak_elo = rb if is_top_radiant else ra
        p_top = expected_win(top_elo, weak_elo)
        actual_top = (m["radiant_win"] if is_top_radiant else not m["radiant_win"])

        eps = 1e-9
        log_loss -= (actual_top * math.log(max(p_top, eps)) + (1 - actual_top) * math.log(max(1 - p_top, eps)))
        brier += (p_top - actual_top) ** 2
        if (p_top > 0.5) == actual_top:
            correct += 1
        else:
            upsets += 1
        if actual_top:
            top_wins += 1
        elo_gaps.append(abs(top_elo - weak_elo))
        n += 1

    print(f"  样本:        {n} 场")
    print(f"  Top 20 胜率: {top_wins / n * 100:.1f}%   ({top_wins}/{n})")
    print(f"  模型准确率:  {correct / n * 100:.1f}%   ({correct}/{n})")
    print(f"  冷门率:      {upsets / n * 100:.1f}%   (弱队赢 {upsets}/{n})")
    print(f"  log_loss:    {log_loss / n:.4f}")
    print(f"  Brier:       {brier / n:.4f}")
    print(f"  平均 Elo 差: {sum(elo_gaps) / n:.1f}")
    print()


def compare_three_categories(s, both, one, none, top_ids):
    """三类比赛预测表现对比。"""
    print(f"=== 模式 2：三类比赛预测表现对比 ===")
    print(f"  {'类别':<20} {'样本':>6} {'准确率':>8} {'log_loss':>10} {'Brier':>8}")
    for name, matches in [("双方都 top 20", both), ("一方 top 20", one), ("双方都非 top 20", none)]:
        n = 0
        correct = 0
        log_loss = 0.0
        brier = 0.0
        for m in matches:
            with session_scope() as ss:
                ra = get_match_elo(ss, m["radiant_team_id"], m["match_id"])
                rb = get_match_elo(ss, m["dire_team_id"], m["match_id"])
            p_a = expected_win(ra, rb)
            actual_a = 1.0 if m["radiant_win"] else 0.0
            eps = 1e-9
            log_loss -= (actual_a * math.log(max(p_a, eps)) + (1 - actual_a) * math.log(max(1 - p_a, eps)))
            brier += (p_a - actual_a) ** 2
            if (p_a > 0.5) == m["radiant_win"]:
                correct += 1
            n += 1
        if n > 0:
            print(f"  {name:<20} {n:>6} {correct / n * 100:>7.1f}% {log_loss / n:>10.4f} {brier / n:>8.4f}")
    print()


def elo_gap_buckets(s, matches, top_ids):
    """按 Elo 差距分桶，看模型在不同差距下的准确率（一方 top 20）。"""
    print(f"=== 模式 3：一方 top 20 时，按 Elo 差距分桶 ===")
    print(f"  {'差距区间':<12} {'样本':>6} {'强队胜率':>9} {'准确率':>8} {'校准':>8}")
    buckets = [
        (0, 50, "0-50"),
        (50, 100, "50-100"),
        (100, 150, "100-150"),
        (150, 200, "150-200"),
        (200, 300, "200-300"),
        (300, 500, "300-500"),
        (500, 10000, "500+"),
    ]
    bucket_data = {label: {"n": 0, "correct": 0, "top_wins": 0} for _, _, label in buckets}

    for m in matches:
        with session_scope() as ss:
            ra = get_match_elo(ss, m["radiant_team_id"], m["match_id"])
            rb = get_match_elo(ss, m["dire_team_id"], m["match_id"])
        is_top_radiant = m["radiant_team_id"] in top_ids
        top_elo = ra if is_top_radiant else rb
        weak_elo = rb if is_top_radiant else ra
        gap = top_elo - weak_elo
        p_top = expected_win(top_elo, weak_elo)
        actual_top = (m["radiant_win"] if is_top_radiant else not m["radiant_win"])
        correct = (p_top > 0.5) == actual_top

        for lo, hi, label in buckets:
            if lo <= gap < hi:
                bucket_data[label]["n"] += 1
                if correct:
                    bucket_data[label]["correct"] += 1
                if actual_top:
                    bucket_data[label]["top_wins"] += 1
                break

    for lo, hi, label in buckets:
        d = bucket_data[label]
        if d["n"] == 0:
            continue
        # 中位数差距作期望胜率
        mid_gap = (lo + hi) / 2
        expected_top = expected_win(1500 + mid_gap / 2, 1500 - mid_gap / 2)
        acc = d["correct"] / d["n"]
        calib = d["top_wins"] / d["n"] - expected_top
        print(f"  {label:<12} {d['n']:>6} {d['top_wins'] / d['n'] * 100:>8.1f}% {acc * 100:>7.1f}% {calib * 100:>+7.1f}%")
    print()


def analyze_strong_vs_weak(s, matches, top_ids):
    """强队作为不同 Elo 排名时的表现。"""
    print(f"=== 模式 4：不同 top 排名作为强队时的翻车率 ===")
    # 按 top 排名分桶
    top_rank = {t.id: i + 1 for i, t in enumerate(
        s.query(Team).order_by(Team.rating.desc()).limit(20).all()
    )}

    rank_groups = [
        (1, 5, "1-5 (顶尖)"),
        (6, 10, "6-10 (强)"),
        (11, 15, "11-15 (中)"),
        (16, 20, "16-20 (弱)"),
    ]
    group_data = {label: {"n": 0, "wins": 0, "losses": 0} for _, _, label in rank_groups}

    for m in matches:
        with session_scope() as ss:
            ra = get_match_elo(ss, m["radiant_team_id"], m["match_id"])
            rb = get_match_elo(ss, m["dire_team_id"], m["match_id"])
        if m["radiant_team_id"] in top_ids:
            top_id = m["radiant_team_id"]
            is_radiant = True
        elif m["dire_team_id"] in top_ids:
            top_id = m["dire_team_id"]
            is_radiant = False
        else:
            continue
        rank = top_rank[top_id]
        top_won = (m["radiant_win"] if is_radiant else not m["radiant_win"])
        for lo, hi, label in rank_groups:
            if lo <= rank <= hi:
                group_data[label]["n"] += 1
                if top_won:
                    group_data[label]["wins"] += 1
                else:
                    group_data[label]["losses"] += 1
                break

    print(f"  {'排名段':<15} {'比赛':>6} {'胜':>5} {'负':>5} {'胜率':>8} {'翻车率':>8}")
    for lo, hi, label in rank_groups:
        d = group_data[label]
        if d["n"] == 0:
            continue
        print(f"  {label:<15} {d['n']:>6} {d['wins']:>5} {d['losses']:>5} {d['wins'] / d['n'] * 100:>7.1f}% {d['losses'] / d['n'] * 100:>7.1f}%")
    print()


if __name__ == "__main__":
    main()
