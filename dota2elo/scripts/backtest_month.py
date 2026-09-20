"""
9 月比赛专项回测

用法：
  python scripts/backtest_month.py              # 默认 2026-09
  python scripts/backtest_month.py --month 2026-08
"""
import sys
import os
import math
import argparse
from collections import defaultdict, Counter
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match, RatingHistory, Team, Player, PlayerMatchStat
from dota2elo.elo import (
    meets_winrate_75_conditions, meets_winrate_80_conditions, TeamRating
)


def get_match_elo_before(s, team_id: int, before_match_id: int) -> float:
    """取这场比赛发生时该队的最近 Elo。"""
    r = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).first()
    if r:
        return r.elo_after
    t = s.get(Team, team_id)
    return t.rating if t else 1500.0


def get_roster_before(s, team_id: int, before_match_id: int, lookback: int = 5):
    """取该队这场比赛发生前最近 5 场的常用选手 Elo。"""
    # 找最近 N 场该队参与的 match_id
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--month", type=int, default=9)
    args = parser.parse_args()

    print("=" * 70)
    print(f"  {args.year}-{args.month:02d} 月比赛回测")
    print("=" * 70)
    print()

    # 收集 9 月比赛
    with session_scope() as s:
        matches = s.query(Match).filter(
            Match.start_time >= datetime(args.year, args.month, 1),
            Match.start_time < datetime(args.year, args.month + 1, 1) if args.month < 12
                else datetime(args.year + 1, 1, 1),
            Match.radiant_win.isnot(None),
            Match.radiant_team_id.isnot(None),
            Match.dire_team_id.isnot(None),
        ).order_by(Match.start_time).all()
        # Materialize
        matches_data = [{
            "match_id": m.match_id,
            "start_time": m.start_time,
            "league_name": m.league_name or "?",
            "series_type": m.series_type or "bo1",
            "a_id": m.radiant_team_id,
            "b_id": m.dire_team_id,
            "radiant_win": bool(m.radiant_win),
        } for m in matches]

    n_total = len(matches_data)
    print(f"样本: {n_total} 场\n")

    if n_total == 0:
        print("无比赛")
        return

    # 逐场回测
    stats = {
        "n": 0,
        "n_with_roster": 0,
        "log_loss": 0.0,
        "brier": 0.0,
        "n_75": 0,
        "n_correct_75": 0,
        "n_80": 0,
        "n_correct_80": 0,
        "n_upset": 0,
        "n_bo1": 0,
        "n_bo1_75": 0,
        "n_bo1_correct_75": 0,
        "n_bo3": 0,
        "n_bo3_75": 0,
        "n_bo3_correct_75": 0,
        "n_bo5": 0,
        "n_bo5_75": 0,
        "n_bo5_correct_75": 0,
        "n_correct_50": 0,  # 基线
    }

    triggered_matches = []  # 触发 75% 的比赛详情

    for m in matches_data:
        with session_scope() as s:
            ra = get_match_elo_before(s, m["a_id"], m["match_id"])
            rb = get_match_elo_before(s, m["b_id"], m["match_id"])
            if ra is None or rb is None:
                continue

            roster_a = get_roster_before(s, m["a_id"], m["match_id"])
            roster_b = get_roster_before(s, m["b_id"], m["match_id"])
            if roster_a and roster_b:
                stats["n_with_roster"] += 1

            team_a = TeamRating(team_id=m["a_id"], team_elo=ra, games=10, player_elo=roster_a)
            team_b = TeamRating(team_id=m["b_id"], team_elo=rb, games=10, player_elo=roster_b)

            # favorite = Elo 高
            if ra >= rb:
                fav_is_radiant = True
            else:
                fav_is_radiant = False
            fav_won = m["radiant_win"] if fav_is_radiant else not m["radiant_win"]
            actual_fav = 1.0 if fav_won else 0.0

            # 用 logistic 算
            p_fav = 1.0 / (1.0 + 10 ** ((min(ra, rb) - max(ra, rb)) / 400.0))
            p_used = p_fav  # favorite 的胜率

            eps = 1e-9
            stats["log_loss"] -= (actual_fav * math.log(max(p_used, eps)) +
                                    (1 - actual_fav) * math.log(max(1 - p_used, eps)))
            stats["brier"] += (p_used - actual_fav) ** 2
            stats["n"] += 1

            # 基线
            if (p_used > 0.5) == fav_won:
                stats["n_correct_50"] += 1

            # upset
            if (p_used > 0.5) != fav_won:
                stats["n_upset"] += 1

            # 75% / 80%
            series_int = {"bo1": 0, "bo3": 1, "bo5": 2}.get(m["series_type"], 1)
            st_key = f"bo{series_int + 1}" if series_int > 0 else "bo1"
            # 累加 series 统计
            stats[f"n_{st_key}"] = stats.get(f"n_{st_key}", 0) + 1

            wr75 = meets_winrate_75_conditions(team_a, team_b, series_type=series_int)
            if wr75.meets:
                stats["n_75"] += 1
                if (p_used > 0.5) == fav_won:
                    stats["n_correct_75"] += 1
                stats[f"n_{st_key}_75"] = stats.get(f"n_{st_key}_75", 0) + 1
                if (p_used > 0.5) == fav_won:
                    stats[f"n_{st_key}_correct_75"] = stats.get(f"n_{st_key}_correct_75", 0) + 1
                triggered_matches.append({
                    "time": m["start_time"].strftime("%m-%d %H:%M"),
                    "league": (m["league_name"] or "?")[:20],
                    "a": s.get(Team, m["a_id"]).name,
                    "b": s.get(Team, m["b_id"]).name,
                    "elo_a": ra, "elo_b": rb,
                    "roster_a": sum(roster_a.values()) / len(roster_a) if roster_a else None,
                    "roster_b": sum(roster_b.values()) / len(roster_b) if roster_b else None,
                    "p_a_win": p_used if fav_is_radiant else 1 - p_used,
                    "actual_a_won": m["radiant_win"],
                    "signal": wr75.best_signal,
                    "exp": wr75.expected_winrate,
                })

            wr80 = meets_winrate_80_conditions(team_a, team_b, series_type=series_int)
            if wr80.meets:
                stats["n_80"] += 1
                if (p_used > 0.5) == fav_won:
                    stats["n_correct_80"] += 1

    n = max(1, stats["n"])
    print("=" * 70)
    print(f"  整体指标（{stats['n']} 场）")
    print("=" * 70)
    print(f"  基线（>50% 触发）准确率:  {stats['n_correct_50']/n*100:.1f}%   ({stats['n_correct_50']}/{n})")
    print(f"  log_loss:                  {stats['log_loss']/n:.4f}")
    print(f"  Brier:                     {stats['brier']/n:.4f}")
    print(f"  冷门率:                    {stats['n_upset']/n*100:.1f}%   ({stats['n_upset']}/{n})")
    print(f"  有 roster 数据的场次:      {stats['n_with_roster']}/{n}  ({stats['n_with_roster']/n*100:.0f}%)")
    print()

    print("=" * 70)
    print("  HC@75 / HC@80 命中率")
    print("=" * 70)
    if stats["n_75"] > 0:
        print(f"  HC@75 触发:  {stats['n_75']:>3} 场  命中率: {stats['n_correct_75']/stats['n_75']*100:.1f}%   ({stats['n_correct_75']}/{stats['n_75']})")
    if stats["n_80"] > 0:
        print(f"  HC@80 触发:  {stats['n_80']:>3} 场  命中率: {stats['n_correct_80']/stats['n_80']*100:.1f}%   ({stats['n_correct_80']}/{stats['n_80']})")
    print()

    # 按 series 拆分
    print("=" * 70)
    print("  按 series 拆分")
    print("=" * 70)
    print(f"  {'系列':<8} {'总数':>6} {'触发':>6} {'命中率':>8}")
    for st in ["bo1", "bo3", "bo5"]:
        n_st = stats.get(f"n_{st}", 0)
        n_75 = stats.get(f"n_{st}_75", 0)
        n_corr = stats.get(f"n_{st}_correct_75", 0)
        if n_st > 0:
            wr = n_corr / n_75 * 100 if n_75 else 0
            print(f"  {st:<8} {n_st:>6} {n_75:>6} {wr:>7.1f}%")

    # 触发的比赛详情
    if triggered_matches:
        print()
        print("=" * 70)
        print(f"  触发 75% 条件的 {len(triggered_matches)} 场详情")
        print("=" * 70)
        print(f"  {'时间':<13} {'联赛':<18} {'对阵':<32} {'p':>5} {'实':>4} {'exp':>5} {'信号':<30}")
        for t in triggered_matches:
            actual_str = "A✓" if t["actual_a_won"] else "B✓"
            win = (t["p_a_win"] > 0.5) == t["actual_a_won"]
            mark = "✅" if win else "❌"
            print(f"  {t['time']:<13} {t['league']:<18} {t['a'][:12]:<12} vs {t['b'][:12]:<12}  "
                  f"{t['p_a_win']*100:>4.0f}%  {actual_str:>4} {t['exp']*100:>4.0f}%  "
                  f"{mark} {t['signal'][:25]}")


if __name__ == "__main__":
    main()
