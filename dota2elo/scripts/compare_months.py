"""
多月对比汇总：把多个月的回测指标放在一起看

用法：
  python scripts/compare_months.py 7 8 9
"""
import sys
import os
import math
import argparse
from collections import defaultdict
from datetime import datetime
from bisect import bisect_left

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match, RatingHistory, Team, Player, PlayerMatchStat
from dota2elo.elo import (
    meets_winrate_75_conditions, meets_winrate_80_conditions, TeamRating
)


def get_match_elo_before(s, team_id: int, before_match_id: int) -> float:
    r = s.query(RatingHistory).filter(
        RatingHistory.team_id == team_id,
        RatingHistory.match_id < before_match_id,
    ).order_by(RatingHistory.match_id.desc()).first()
    if r:
        return r.elo_after
    t = s.get(Team, team_id)
    return t.rating if t else 1500.0


def get_roster_before(s, team_id: int, before_match_id: int, lookback: int = 5):
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
    from collections import Counter
    cnt = Counter(r.player_id for r in rows)
    threshold = max(1, len(match_ids) // 2)
    top5 = [pid for pid, c in cnt.most_common(5) if c >= threshold] or [pid for pid, _ in cnt.most_common(5)]
    if not top5:
        return {}
    players = s.query(Player).filter(Player.id.in_(top5)).all()
    return {p.id: p.current_elo for p in players}


def compute_month(year: int, month: int) -> dict:
    """单月回测，返回指标。"""
    with session_scope() as s:
        if month < 12:
            matches = s.query(Match).filter(
                Match.start_time >= datetime(year, month, 1),
                Match.start_time < datetime(year, month + 1, 1),
                Match.radiant_win.isnot(None),
                Match.radiant_team_id.isnot(None),
                Match.dire_team_id.isnot(None),
            ).order_by(Match.start_time).all()
        else:
            matches = s.query(Match).filter(
                Match.start_time >= datetime(year, month, 1),
                Match.start_time < datetime(year + 1, 1, 1),
                Match.radiant_win.isnot(None),
                Match.radiant_team_id.isnot(None),
                Match.dire_team_id.isnot(None),
            ).order_by(Match.start_time).all()

        stats = {
            "n": 0, "n_roster": 0,
            "log_loss": 0.0, "brier": 0.0,
            "n_upset": 0, "n_50": 0,
            "n_75": 0, "n_75_correct": 0,
            "n_80": 0, "n_80_correct": 0,
            "leagues": defaultdict(int),
            "bo1_n": 0, "bo1_75": 0, "bo1_75_correct": 0,
            "bo3_n": 0, "bo3_75": 0, "bo3_75_correct": 0,
        }

        for m in matches:
            with session_scope() as ss:
                ra = get_match_elo_before(ss, m.radiant_team_id, m.match_id)
                rb = get_match_elo_before(ss, m.dire_team_id, m.match_id)
                if ra is None or rb is None:
                    continue
                roster_a = get_roster_before(ss, m.radiant_team_id, m.match_id)
                roster_b = get_roster_before(ss, m.dire_team_id, m.match_id)
                if roster_a and roster_b:
                    stats["n_roster"] += 1

                team_a = TeamRating(team_id=m.radiant_team_id, team_elo=ra, games=10, player_elo=roster_a)
                team_b = TeamRating(team_id=m.dire_team_id, team_elo=rb, games=10, player_elo=roster_b)

                if ra >= rb:
                    fav_is_radiant = True
                else:
                    fav_is_radiant = False
                fav_won = m.radiant_win if fav_is_radiant else not m.radiant_win
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
                stats["leagues"][m.league_name or "?"] += 1

                series_int = {"bo1": 0, "bo3": 1, "bo5": 2}.get(m.series_type, 1)
                st_key = f"bo{series_int + 1}" if series_int > 0 else "bo1"
                if st_key in ["bo1", "bo3"]:
                    stats[f"{st_key}_n"] += 1

                wr75 = meets_winrate_75_conditions(team_a, team_b, series_type=series_int)
                if wr75.meets:
                    stats["n_75"] += 1
                    if (p_fav > 0.5) == fav_won:
                        stats["n_75_correct"] += 1
                    if st_key in ["bo1", "bo3"]:
                        stats[f"{st_key}_75"] += 1
                        if (p_fav > 0.5) == fav_won:
                            stats[f"{st_key}_75_correct"] += 1

                wr80 = meets_winrate_80_conditions(team_a, team_b, series_type=series_int)
                if wr80.meets:
                    stats["n_80"] += 1
                    if (p_fav > 0.5) == fav_won:
                        stats["n_80_correct"] += 1

    return stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("months", type=int, nargs="+", help="月份列表（默认 2026 年）")
    parser.add_argument("--year", type=int, default=2026)
    args = parser.parse_args()

    print("=" * 90)
    print(f"  多月回测对比 ({args.year})")
    print("=" * 90)
    print()

    all_stats = {}
    for m in args.months:
        s = compute_month(args.year, m)
        all_stats[m] = s

    # 输出对比表
    print(f"  {'指标':<24}", end="")
    for m in args.months:
        print(f"  {args.year}-{m:02d}", end="")
    print()
    print("  " + "-" * 86)

    rows = [
        ("样本数", lambda s: s["n"], "{n}"),
        ("基线准确率", lambda s: s["n_50"] / s["n"] * 100 if s["n"] else 0, "{acc:.1f}%"),
        ("log_loss", lambda s: s["log_loss"] / s["n"] if s["n"] else 0, "{val:.4f}"),
        ("Brier", lambda s: s["brier"] / s["n"] if s["n"] else 0, "{val:.4f}"),
        ("冷门率", lambda s: s["n_upset"] / s["n"] * 100 if s["n"] else 0, "{upset:.1f}%"),
        ("roster 覆盖率", lambda s: s["n_roster"] / s["n"] * 100 if s["n"] else 0, "{cov:.0f}%"),
        ("HC@75 触发数", lambda s: s["n_75"], "{n}"),
        ("HC@75 命中率", lambda s: s["n_75_correct"] / s["n_75"] * 100 if s["n_75"] else 0, "{acc:.1f}%"),
        ("HC@80 触发数", lambda s: s["n_80"], "{n}"),
        ("HC@80 命中率", lambda s: s["n_80_correct"] / s["n_80"] * 100 if s["n_80"] else 0, "{acc:.1f}%"),
    ]

    for label, fn, fmt in rows:
        print(f"  {label:<22}  ", end="")
        for m in args.months:
            s = all_stats[m]
            val = fn(s)
            if "n" in fmt and "acc" not in fmt and "val" not in fmt and "upset" not in fmt and "cov" not in fmt:
                formatted = fmt.format(n=int(val))
            elif "acc" in fmt:
                formatted = fmt.format(acc=val)
            elif "val" in fmt:
                formatted = fmt.format(val=val)
            elif "upset" in fmt:
                formatted = fmt.format(upset=val)
            elif "cov" in fmt:
                formatted = fmt.format(cov=val)
            else:
                formatted = str(int(val))
            print(f"  {formatted:>8}", end="")
        print()

    # Top 联赛
    print()
    print("=" * 90)
    print("  各月 Top 联赛")
    print("=" * 90)
    for m in args.months:
        s = all_stats[m]
        top_leagues = sorted(s["leagues"].items(), key=lambda x: -x[1])[:5]
        leagues_str = ", ".join(f"{name[:30]}: {cnt}" for name, cnt in top_leagues)
        print(f"  {args.year}-{m:02d}: {leagues_str}")


if __name__ == "__main__":
    main()
