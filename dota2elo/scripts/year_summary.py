"""
全年回测汇总：把 2025 + 2026 几个月合在一起看

用法：
  python scripts/year_summary.py
"""
import sys
import os
import math
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match, RatingHistory, Team, Player, PlayerMatchStat
from dota2elo.elo import (
    meets_winrate_75_conditions, meets_winrate_80_conditions, TeamRating
)


def get_match_elo_before(s, team_id, before_match_id):
    r = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).first()
    if r:
        return r.elo_after
    t = s.get(Team, team_id)
    return t.rating if t else 1500.0


def get_roster_before(s, team_id, before_match_id, lookback=5):
    from collections import Counter
    match_ids = [m.match_id for m in s.query(PlayerMatchStat.match_id)
                 .filter(PlayerMatchStat.team_id == team_id,
                         PlayerMatchStat.match_id < before_match_id)
                 .order_by(PlayerMatchStat.match_id.desc())
                 .distinct().limit(lookback * 10).all()]
    match_ids = match_ids[:lookback]
    if not match_ids:
        return {}
    rows = s.query(PlayerMatchStat).filter(
        PlayerMatchStat.team_id == team_id,
        PlayerMatchStat.match_id.in_(match_ids)
    ).all()
    cnt = Counter(r.player_id for r in rows)
    threshold = max(1, len(match_ids) // 2)
    top5 = [pid for pid, c in cnt.most_common(5) if c >= threshold] or [pid for pid, _ in cnt.most_common(5)]
    if not top5:
        return {}
    players = s.query(Player).filter(Player.id.in_(top5)).all()
    return {p.id: p.current_elo for p in players}


def compute_range(start_year, start_month, end_year, end_month):
    """整段范围回测。"""
    start = datetime(start_year, start_month, 1)
    if end_month == 12:
        end = datetime(end_year + 1, 1, 1)
    else:
        end = datetime(end_year, end_month + 1, 1)

    with session_scope() as s:
        matches = s.query(Match).filter(
            Match.start_time >= start,
            Match.start_time < end,
            Match.radiant_win.isnot(None),
            Match.radiant_team_id.isnot(None),
            Match.dire_team_id.isnot(None),
        ).all()
        matches_data = [{
            "match_id": m.match_id,
            "start_time": m.start_time,
            "league_name": m.league_name or "?",
            "series_type": m.series_type or "bo1",
            "a_id": m.radiant_team_id,
            "b_id": m.dire_team_id,
            "radiant_win": bool(m.radiant_win),
        } for m in matches]

    stats = {
        "n": 0, "n_roster": 0,
        "log_loss": 0.0, "brier": 0.0,
        "n_upset": 0, "n_50": 0,
        "n_75": 0, "n_75_correct": 0,
        "n_80": 0, "n_80_correct": 0,
        "by_month": defaultdict(lambda: {"n": 0, "n_75": 0, "n_75_correct": 0}),
        "by_league": defaultdict(int),
    }

    for m in matches_data:
        with session_scope() as s:
            ra = get_match_elo_before(s, m["a_id"], m["match_id"])
            rb = get_match_elo_before(s, m["b_id"], m["match_id"])
            if ra is None or rb is None:
                continue
            roster_a = get_roster_before(s, m["a_id"], m["match_id"])
            roster_b = get_roster_before(s, m["b_id"], m["match_id"])
            if roster_a and roster_b:
                stats["n_roster"] += 1

            team_a = TeamRating(team_id=m["a_id"], team_elo=ra, games=10, player_elo=roster_a)
            team_b = TeamRating(team_id=m["b_id"], team_elo=rb, games=10, player_elo=roster_b)

            if ra >= rb:
                fav_is_radiant = True
            else:
                fav_is_radiant = False
            fav_won = m["radiant_win"] if fav_is_radiant else not m["radiant_win"]
            actual_fav = 1.0 if fav_won else 0.0
            p_fav = 1.0 / (1.0 + 10 ** ((min(ra, rb) - max(ra, rb)) / 400.0))

            eps = 1e-9
            stats["log_loss"] -= (actual_fav * math.log(max(p_fav, eps)) +
                                    (1 - actual_fav) * math.log(max(1 - p_fav, eps)))
            stats["brier"] += (p_fav - actual_fav) ** 2
            stats["n"] += 1
            if (p_fav > 0.5) == fav_won:
                stats["n_50"] += 1
            if (p_fav > 0.5) != fav_won:
                stats["n_upset"] += 1
            stats["by_league"][m["league_name"] or "?"] += 1

            # 按月统计
            ym = m["start_time"].strftime("%Y-%m")
            stats["by_month"][ym]["n"] += 1

            series_int = {"bo1": 0, "bo3": 1, "bo5": 2}.get(m["series_type"], 1)
            wr75 = meets_winrate_75_conditions(team_a, team_b, series_type=series_int)
            if wr75.meets:
                stats["n_75"] += 1
                if (p_fav > 0.5) == fav_won:
                    stats["n_75_correct"] += 1
                stats["by_month"][ym]["n_75"] += 1
                if (p_fav > 0.5) == fav_won:
                    stats["by_month"][ym]["n_75_correct"] += 1

            wr80 = meets_winrate_80_conditions(team_a, team_b, series_type=series_int)
            if wr80.meets:
                stats["n_80"] += 1
                if (p_fav > 0.5) == fav_won:
                    stats["n_80_correct"] += 1

    return stats


def main():
    print("=" * 90)
    print("  全年回测汇总（2025-01 ~ 2026-09，含 2026-03 以来补全数据）")
    print("=" * 90)
    print()

    # 2025 年 1-9 月
    s1 = compute_range(2025, 1, 2025, 9)
    # 2026 年 3-9 月
    s2 = compute_range(2026, 3, 2026, 9)

    n_total = s1["n"] + s2["n"]
    n_75_total = s1["n_75"] + s2["n_75"]
    n_75_correct_total = s1["n_75_correct"] + s2["n_75_correct"]
    n_80_total = s1["n_80"] + s2["n_80"]
    n_80_correct_total = s1["n_80_correct"] + s2["n_80_correct"]
    n_50_total = s1["n_50"] + s2["n_50"]
    n_upset_total = s1["n_upset"] + s2["n_upset"]
    n_roster_total = s1["n_roster"] + s2["n_roster"]
    ll_total = s1["log_loss"] + s2["log_loss"]
    br_total = s1["brier"] + s2["brier"]

    print(f"  {'指标':<28} {'2025 (1-9)':<14} {'2026 (7-9)':<14} {'合计':<14}")
    print("  " + "-" * 70)
    print(f"  {'样本数':<26}  {s1['n']:>10}   {s2['n']:>10}   {n_total:>10}")
    print(f"  {'基线准确率（>50%）':<24}  {s1['n_50']/s1['n']*100:>9.1f}%  {s2['n_50']/s2['n']*100:>9.1f}%  {n_50_total/n_total*100:>9.1f}%")
    print(f"  {'log_loss':<26}  {s1['log_loss']/s1['n']:>10.4f}  {s2['log_loss']/s2['n']:>10.4f}  {ll_total/n_total:>10.4f}")
    print(f"  {'Brier':<26}  {s1['brier']/s1['n']:>10.4f}  {s2['brier']/s2['n']:>10.4f}  {br_total/n_total:>10.4f}")
    print(f"  {'冷门率':<26}  {s1['n_upset']/s1['n']*100:>9.1f}%  {s2['n_upset']/s2['n']*100:>9.1f}%  {n_upset_total/n_total*100:>9.1f}%")
    print(f"  {'roster 覆盖率':<24}  {s1['n_roster']/s1['n']*100:>9.1f}%  {s2['n_roster']/s2['n']*100:>9.1f}%  {n_roster_total/n_total*100:>9.1f}%")
    print()
    print(f"  {'HC@75 触发数':<24}  {s1['n_75']:>10}   {s2['n_75']:>10}   {n_75_total:>10}")
    print(f"  {'HC@75 命中率':<24}  {s1['n_75_correct']/s1['n_75']*100 if s1['n_75'] else 0:>9.1f}%  {s2['n_75_correct']/s2['n_75']*100 if s2['n_75'] else 0:>9.1f}%  {n_75_correct_total/n_75_total*100 if n_75_total else 0:>9.1f}%")
    print(f"  {'HC@80 触发数':<24}  {s1['n_80']:>10}   {s2['n_80']:>10}   {n_80_total:>10}")
    print(f"  {'HC@80 命中率':<24}  {s1['n_80_correct']/s1['n_80']*100 if s1['n_80'] else 0:>9.1f}%  {s2['n_80_correct']/s2['n_80']*100 if s2['n_80'] else 0:>9.1f}%  {n_80_correct_total/n_80_total*100 if n_80_total else 0:>9.1f}%")
    print()

    # Top 联赛
    print(f"  {'总触发 HC@75 场数':<24}  {s1['n_75'] + s2['n_75']:>10}")
    print()

    # 月度趋势
    print("=" * 90)
    print("  HC@75 月度趋势")
    print("=" * 90)
    print(f"  {'月份':<10} {'总数':>6} {'触发':>6} {'命中':>6} {'命中率':>8} {'联赛代表':<40}")
    print("  " + "-" * 90)

    # 合并月度
    by_month = {}
    for k, v in s1["by_month"].items():
        by_month[k] = v
    for k, v in s2["by_month"].items():
        by_month[k] = v
    # 加 league 信息
    with session_scope() as s:
        leagues_by_month = {}
        for m in s.query(Match).all():
            if m.radiant_win is not None and m.start_time:
                ym = m.start_time.strftime("%Y-%m")
                if ym not in leagues_by_month:
                    leagues_by_month[ym] = {}
                leagues_by_month[ym][m.league_name or "?"] = leagues_by_month[ym].get(m.league_name or "?", 0) + 1

    for ym in sorted(by_month.keys()):
        n = by_month[ym]["n"]
        n_75 = by_month[ym]["n_75"]
        n_75_c = by_month[ym]["n_75_correct"]
        wr = n_75_c / n_75 * 100 if n_75 > 0 else 0
        top_lg = sorted(leagues_by_month.get(ym, {}).items(), key=lambda x: -x[1])[:1]
        lg_str = f"{top_lg[0][0][:35]} ({top_lg[0][1]})" if top_lg else "?"
        print(f"  {ym:<10} {n:>6} {n_75:>6} {n_75_c:>6} {wr:>7.1f}% {lg_str}")

    # Top 联赛
    print()
    print("=" * 90)
    print("  Top 联赛（按场次）")
    print("=" * 90)
    all_leagues = {}
    for k, v in s1["by_league"].items():
        all_leagues[k] = all_leagues.get(k, 0) + v
    for k, v in s2["by_league"].items():
        all_leagues[k] = all_leagues.get(k, 0) + v
    for lg, cnt in sorted(all_leagues.items(), key=lambda x: -x[1])[:15]:
        print(f"  {cnt:>4}  {lg[:50]}")


if __name__ == "__main__":
    main()
