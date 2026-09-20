"""
分析 top 10 队伍 + Elo 差距 > 200 的比赛。

输出：
- 整体胜率 / 翻盘率
- 强队 vs 弱队分类（top10 vs top10 / top10 vs 非 top10）
- 按 Elo 差距分桶
- 最大翻盘记录
"""
import sys
import os
import math
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Team, Match, RatingHistory


def get_match_elo(s, team_id, before_match_id):
    r = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).first()
    if r:
        return r.elo_after
    t = s.get(Team, team_id)
    return t.rating if t else 1500.0


def expected_win(ra, rb):
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def main():
    with session_scope() as s:
        top10 = s.query(Team).order_by(Team.rating.desc()).limit(10).all()
        top10_ids = {t.id for t in top10}
        top10_rank = {t.id: i + 1 for i, t in enumerate(top10)}

        print(f"=== Top 10 战队 ===")
        for i, t in enumerate(top10, 1):
            print(f"  {i:>2}. {t.name:<30}  Elo={t.rating:>7.1f}")
        print()

        # 收集所有 top10 一方 + 差距 > 200 的比赛，materialize 成 dict
        all_matches = s.query(Match).filter(
            Match.radiant_win.isnot(None),
            ((Match.radiant_team_id.in_(top10_ids)) | (Match.dire_team_id.in_(top10_ids))),
        ).all()

        rows = []  # (gap, p_strong, strong_won, is_top_vs_top, league, start_time, strong_id, weak_id)
        for m in all_matches:
            ra = get_match_elo(s, m.radiant_team_id, m.match_id)
            rb = get_match_elo(s, m.dire_team_id, m.match_id)
            gap = abs(ra - rb)
            if gap <= 200:
                continue
            if ra == rb:
                continue

            if ra > rb:
                strong_is_radiant = True
            else:
                strong_is_radiant = False
            strong_id = m.radiant_team_id if strong_is_radiant else m.dire_team_id
            weak_id = m.dire_team_id if strong_is_radiant else m.radiant_team_id
            strong_elo = max(ra, rb)
            weak_elo = min(ra, rb)
            p_strong = expected_win(strong_elo, weak_elo)
            strong_won = m.radiant_win if strong_is_radiant else not m.radiant_win
            is_tvt = (m.radiant_team_id in top10_ids) and (m.dire_team_id in top10_ids)
            rows.append({
                "match_id": m.match_id,
                "gap": gap,
                "p_strong": p_strong,
                "strong_won": strong_won,
                "is_tvt": is_tvt,
                "league": m.league_name,
                "start_time": m.start_time,
                "strong_id": strong_id,
                "weak_id": weak_id,
                "strong_elo": strong_elo,
                "weak_elo": weak_elo,
            })

        # === 整体指标 ===
        n = len(rows)
        strong_wins = sum(1 for r in rows if r["strong_won"])
        upsets = n - strong_wins
        correct = sum(1 for r in rows if (r["p_strong"] > 0.5) == r["strong_won"])
        log_loss = 0.0
        brier = 0.0
        for r in rows:
            actual = 1.0 if r["strong_won"] else 0.0
            p = r["p_strong"]
            eps = 1e-9
            log_loss -= (actual * math.log(max(p, eps)) + (1 - actual) * math.log(max(1 - p, eps)))
            brier += (p - actual) ** 2

        print(f"=== Top 10 + Elo 差 > 200 比赛 ===")
        print(f"  样本:        {n} 场")
        print(f"  强队胜率:    {strong_wins / n * 100:.1f}%   ({strong_wins}/{n})")
        print(f"  弱队翻盘率:  {upsets / n * 100:.1f}%   ({upsets}/{n})")
        print(f"  模型准确率:  {correct / n * 100:.1f}%   ({correct}/{n})")
        print(f"  log_loss:    {log_loss / n:.4f}")
        print(f"  Brier:       {brier / n:.4f}")
        print(f"  平均 Elo 差: {sum(r['gap'] for r in rows) / n:.1f}")
        print(f"  最大 Elo 差: {max(r['gap'] for r in rows):.1f}")
        print()

        # === 分类 ===
        tvt = [r for r in rows if r["is_tvt"]]
        tvn = [r for r in rows if not r["is_tvt"]]
        print(f"=== 分类 ===")
        for name, group in [("Top 10 vs Top 10", tvt), ("Top 10 vs 非 Top 10", tvn)]:
            if not group:
                continue
            g_n = len(group)
            g_w = sum(1 for r in group if r["strong_won"])
            print(f"  {name:<25}  样本: {g_n:>3}  强队胜: {g_w:>3} ({g_w / g_n * 100:.1f}%)")
        print()

        # === 按 Elo 差距分桶 ===
        buckets = [
            (200, 300, "200-300"),
            (300, 400, "300-400"),
            (400, 500, "400-500"),
            (500, 10000, "500+"),
        ]
        print(f"=== 按 Elo 差距分桶 ===")
        print(f"  {'差距':<10} {'样本':>5} {'强队胜率':>10} {'期望胜率':>10} {'校准偏差':>10}")
        for lo, hi, label in buckets:
            g = [r for r in rows if lo <= r["gap"] < hi]
            if not g:
                continue
            g_n = len(g)
            g_w = sum(1 for r in g if r["strong_won"])
            mid = (lo + min(hi, max(r["gap"] for r in g))) / 2
            p_expected = expected_win(1500 + mid / 2, 1500 - mid / 2)
            actual = g_w / g_n
            calib = actual - p_expected
            print(f"  {label:<10} {g_n:>5} {actual * 100:>9.1f}% {p_expected * 100:>9.1f}% {calib * 100:>+9.1f}%")
        print()

        # === 翻盘统计 ===
        upsets_rows = [r for r in rows if not r["strong_won"]]
        max_gap = max((r["gap"] for r in upsets_rows), default=0)
        print(f"=== 翻盘统计 ===")
        print(f"  翻盘总场次:   {len(upsets_rows)}")
        print(f"  翻盘最大差:   {max_gap:.0f}")
        if upsets_rows:
            upsets_rows.sort(key=lambda r: -r["gap"])
            print(f"  Top 5 最大翻盘:")
            for r in upsets_rows[:5]:
                winner = s.get(Team, r["weak_id"])
                loser = s.get(Team, r["strong_id"])
                print(f"    {r['start_time'].strftime('%Y-%m-%d')}  {winner.name} ({r['weak_elo']:.0f}) 胜 {loser.name} ({r['strong_elo']:.0f})  差 {r['gap']:.0f}  p={r['p_strong']:.2f}  {r['league'][:30] if r['league'] else 'N/A'}")
        print()

        # === 按 top 排名段（强队排名） ===
        print(f"=== 按强队 top 排名段 ===")
        rank_groups = [
            (1, 3, "1-3 (顶尖)"),
            (4, 7, "4-7 (强)"),
            (8, 10, "8-10 (中)"),
        ]
        for lo, hi, label in rank_groups:
            g = [r for r in rows if lo <= top10_rank.get(r["strong_id"], 99) <= hi]
            if not g:
                continue
            g_n = len(g)
            g_w = sum(1 for r in g if r["strong_won"])
            print(f"  {label:<15}  样本: {g_n:>3}  强队胜: {g_w:>3} ({g_w / g_n * 100:.1f}%)")
        print()

        # === 概率分桶 ===
        print(f"=== 预测概率分桶 vs 实际 ===")
        prob_buckets = [
            (0.50, 0.65, "50-65%"),
            (0.65, 0.75, "65-75%"),
            (0.75, 0.85, "75-85%"),
            (0.85, 0.95, "85-95%"),
            (0.95, 1.01, "95-100%"),
        ]
        print(f"  {'概率区间':<12} {'样本':>5} {'实际胜率':>10} {'校准偏差':>10}")
        for lo, hi, label in prob_buckets:
            g = [r for r in rows if lo <= r["p_strong"] < hi]
            if not g:
                continue
            g_n = len(g)
            g_w = sum(1 for r in g if r["strong_won"])
            mid = (lo + hi) / 2
            print(f"  {label:<12} {g_n:>5} {g_w / g_n * 100:>9.1f}% {(g_w / g_n - mid) * 100:>+9.1f}%")


if __name__ == "__main__":
    main()
