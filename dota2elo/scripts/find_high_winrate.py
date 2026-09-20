"""
挖掘实战中胜率 > 75% 的条件组合。

策略：
- 提取每场比赛的多个特征
- 按特征组合分桶，找 (样本 >= N, 胜率 > 75%) 的桶
- 按"信号纯度"排序：胜率 × log(样本量)
"""
import sys
import os
import math
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match, RatingHistory, Team


def get_match_elo(s, team_id, before_match_id):
    r = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).first()
    if r:
        return r.elo_after
    t = s.get(Team, team_id)
    return t.rating if t else 1500.0


def get_recent_form(s, team_id, before_match_id, n=10):
    """近 n 场胜率。"""
    rows = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).limit(n).all()
    if not rows:
        return None
    wins = sum(1 for r in rows if r.result == "W")
    return wins / len(rows)


def main():
    with session_scope() as s:
        # Top 队集合
        top20_ids = {t.id for t in s.query(Team).order_by(Team.rating.desc()).limit(20).all()}
        top10_ids = {t.id for t in s.query(Team).order_by(Team.rating.desc()).limit(10).all()}
        top5_ids = {t.id for t in s.query(Team).order_by(Team.rating.desc()).limit(5).all()}

        # 收集所有比赛特征
        matches = s.query(Match).filter(Match.radiant_win.isnot(None)).all()
        print(f"=== 总比赛数：{len(matches)} ===\n")

        # 对每场比赛，记录 favorite 一方的特征
        rows = []
        for m in matches:
            if not m.radiant_team_id or not m.dire_team_id:
                continue
            ra = get_match_elo(s, m.radiant_team_id, m.match_id)
            rb = get_match_elo(s, m.dire_team_id, m.match_id)
            if ra is None or rb is None or ra == rb:
                continue

            # favorite
            if ra > rb:
                fav_id, weak_id = m.radiant_team_id, m.dire_team_id
                fav_elo, weak_elo = ra, rb
                fav_is_radiant = True
                fav_won = m.radiant_win
            else:
                fav_id, weak_id = m.dire_team_id, m.radiant_team_id
                fav_elo, weak_elo = rb, ra
                fav_is_radiant = False
                fav_won = not m.radiant_win

            gap = fav_elo - weak_elo
            gap_bucket = (int(gap) // 50) * 50
            form = get_recent_form(s, fav_id, m.match_id, n=10)
            form_bucket = (
                "high" if form is not None and form >= 0.7
                else "mid" if form is not None and form >= 0.5
                else "low" if form is not None
                else "unknown"
            )
            fav_in_top5 = fav_id in top5_ids
            fav_in_top10 = fav_id in top10_ids
            fav_in_top20 = fav_id in top20_ids
            weak_in_top20 = weak_id in top20_ids
            series = m.series_type or "unknown"
            league = m.league_name or "Unknown"

            rows.append({
                "gap": gap,
                "gap_bucket": gap_bucket,
                "fav_won": fav_won,
                "fav_in_top5": fav_in_top5,
                "fav_in_top10": fav_in_top10,
                "fav_in_top20": fav_in_top20,
                "weak_in_top20": weak_in_top20,
                "series": series,
                "form": form_bucket,
                "fav_is_radiant": fav_is_radiant,
                "league": league,
            })

        print(f"  有效样本（双方都有 Elo 历史）: {len(rows)}\n")

        # 找高胜率条件
        def find_conditions(min_n=10, min_wr=0.75):
            """找胜率 > 75% 且样本 >= min_n 的条件组合。"""
            results = []

            # 单维：差距
            for gb in sorted({r["gap_bucket"] for r in rows}):
                sub = [r for r in rows if r["gap_bucket"] == gb]
                if len(sub) < min_n:
                    continue
                wr = sum(1 for r in sub if r["fav_won"]) / len(sub)
                if wr >= min_wr:
                    results.append((f"差距 {gb}-{gb+50}", wr, len(sub)))

            # 单维：top 排名
            for tag, pred in [
                ("强队是 top 5", lambda r: r["fav_in_top5"]),
                ("强队是 top 10", lambda r: r["fav_in_top10"]),
                ("强队是 top 20", lambda r: r["fav_in_top20"]),
                ("弱队非 top 20", lambda r: not r["weak_in_top20"]),
                ("强队是 top 5 且弱队非 top 20", lambda r: r["fav_in_top5"] and not r["weak_in_top20"]),
                ("强队是 top 10 且弱队非 top 20", lambda r: r["fav_in_top10"] and not r["weak_in_top20"]),
            ]:
                sub = [r for r in rows if pred(r)]
                if len(sub) < min_n:
                    continue
                wr = sum(1 for r in sub if r["fav_won"]) / len(sub)
                if wr >= min_wr:
                    results.append((tag, wr, len(sub)))

            # 组合：差距 + 排名
            for tag, pred in [
                ("top 5 + 差 200+", lambda r: r["fav_in_top5"] and r["gap"] >= 200),
                ("top 10 + 差 200+", lambda r: r["fav_in_top10"] and r["gap"] >= 200),
                ("top 20 + 差 200+", lambda r: r["fav_in_top20"] and r["gap"] >= 200),
                ("top 5 + 差 300+", lambda r: r["fav_in_top5"] and r["gap"] >= 300),
                ("top 10 + 差 300+", lambda r: r["fav_in_top10"] and r["gap"] >= 300),
                ("top 20 + 差 300+", lambda r: r["fav_in_top20"] and r["gap"] >= 300),
            ]:
                sub = [r for r in rows if pred(r)]
                if len(sub) < min_n:
                    continue
                wr = sum(1 for r in sub if r["fav_won"]) / len(sub)
                if wr >= min_wr:
                    results.append((tag, wr, len(sub)))

            # 组合：差距 + 系列类型
            for st in ["bo1", "bo3", "bo5"]:
                for gap_min in [100, 150, 200, 250, 300]:
                    sub = [r for r in rows if r["series"] == st and r["gap"] >= gap_min]
                    if len(sub) < min_n:
                        continue
                    wr = sum(1 for r in sub if r["fav_won"]) / len(sub)
                    if wr >= min_wr:
                        results.append((f"{st} + 差 {gap_min}+", wr, len(sub)))

            # 组合：差距 + 状态
            for fb in ["high", "mid", "low"]:
                for gap_min in [100, 200, 300]:
                    sub = [r for r in rows if r["form"] == fb and r["gap"] >= gap_min]
                    if len(sub) < min_n:
                        continue
                    wr = sum(1 for r in sub if r["fav_won"]) / len(sub)
                    if wr >= min_wr:
                        results.append((f"近 10 场 {fb} 胜率 + 差 {gap_min}+", wr, len(sub)))

            # 组合：top 排名 + 系列
            for tag, pred in [
                ("top 5 + bo3", lambda r: r["fav_in_top5"] and r["series"] == "bo3"),
                ("top 10 + bo3", lambda r: r["fav_in_top10"] and r["series"] == "bo3"),
                ("top 5 + bo5", lambda r: r["fav_in_top5"] and r["series"] == "bo5"),
                ("top 5 + 差 200+ + bo3", lambda r: r["fav_in_top5"] and r["gap"] >= 200 and r["series"] == "bo3"),
                ("top 10 + 差 200+ + bo3", lambda r: r["fav_in_top10"] and r["gap"] >= 200 and r["series"] == "bo3"),
                ("top 5 + 差 150+ + 高状态", lambda r: r["fav_in_top5"] and r["gap"] >= 150 and r["form"] == "high"),
                ("top 5 + 差 200+ + 高状态", lambda r: r["fav_in_top5"] and r["gap"] >= 200 and r["form"] == "high"),
            ]:
                sub = [r for r in rows if pred(r)]
                if len(sub) < min_n:
                    continue
                wr = sum(1 for r in sub if r["fav_won"]) / len(sub)
                if wr >= min_wr:
                    results.append((tag, wr, len(sub)))

            # 排序：胜率 × log(样本量)
            results.sort(key=lambda x: x[1] * math.log(x[2] + 1), reverse=True)
            return results

        results = find_conditions(min_n=10, min_wr=0.75)

        print(f"=== 胜率 > 75% 的条件（样本 >= 10）===")
        print(f"  {'条件':<40} {'胜率':>8} {'样本':>6}")
        for tag, wr, n in results:
            print(f"  {tag:<40} {wr * 100:>7.1f}% {n:>6}")
        print()

        # 也找胜率 > 80% 和 > 85%
        for thresh in [0.80, 0.85, 0.90]:
            results2 = find_conditions(min_n=10, min_wr=thresh)
            print(f"\n=== 胜率 > {thresh * 100:.0f}% 的强条件 ===")
            if not results2:
                print(f"  无满足条件的桶")
            for tag, wr, n in results2[:10]:
                print(f"  {tag:<40} {wr * 100:>7.1f}% {n:>6}")


if __name__ == "__main__":
    main()
