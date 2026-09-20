"""
80% 高置信度回测（v1.3 新增）

对比 75% 和 80% 条件：
- 触发数（多 vs 少）
- 命中率（高 vs 更高）
- 实用性（高置信场景稀缺性）
"""
import sys
import os
import math
from collections import defaultdict
from bisect import bisect_left

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope
from dota2elo.models import Match, RatingHistory, Team
from dota2elo.elo import (
    meets_winrate_75_conditions, meets_winrate_80_conditions, TeamRating
)
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


def main():
    print("=" * 60)
    print("  80% 高置信度回测（v1.3）")
    print("=" * 60)
    print()

    results = {
        "n": 0,
        "n_75": 0,
        "n_correct_75": 0,
        "n_80": 0,
        "n_correct_80": 0,
    }

    with session_scope() as s:
        matches = s.query(Match).filter(
            Match.radiant_win.isnot(None),
            Match.radiant_team_id.isnot(None),
            Match.dire_team_id.isnot(None),
        ).order_by(Match.start_time.desc()).limit(1000).all()
        # Materialize to dicts
        matches_data = [{
            "match_id": m.match_id,
            "radiant_team_id": m.radiant_team_id,
            "dire_team_id": m.dire_team_id,
            "radiant_win": bool(m.radiant_win),
        } for m in matches]

    print(f"回测样本: {len(matches_data)} 场")

    for m in matches_data:
        with session_scope() as s:
            ra = get_match_elo(s, m["radiant_team_id"], m["match_id"])
            rb = get_match_elo(s, m["dire_team_id"], m["match_id"])
            if ra is None or rb is None:
                continue

            roster_a = get_current_roster(m["radiant_team_id"])
            roster_b = get_current_roster(m["dire_team_id"])
            team_a = TeamRating(
                team_id=m["radiant_team_id"], team_elo=ra, games=10,
                player_elo=roster_a,
            )
            team_b = TeamRating(
                team_id=m["dire_team_id"], team_elo=rb, games=10,
                player_elo=roster_b,
            )

            if ra >= rb:
                fav_is_radiant = True
            else:
                fav_is_radiant = False
            fav_won = m["radiant_win"] if fav_is_radiant else not m["radiant_win"]
            actual_fav = 1.0 if fav_won else 0.0

            wr75 = meets_winrate_75_conditions(team_a, team_b, series_type=1)
            wr80 = meets_winrate_80_conditions(team_a, team_b, series_type=1)

            results["n"] += 1

            if wr75.meets:
                results["n_75"] += 1
                if (wr75.expected_winrate > 0.5) == (actual_fav > 0.5):
                    results["n_correct_75"] += 1

            if wr80.meets:
                results["n_80"] += 1
                if (wr80.expected_winrate > 0.5) == (actual_fav > 0.5):
                    results["n_correct_80"] += 1

    n = max(1, results["n"])
    print()
    print("=== 75% 条件 ===")
    print(f"  触发数:  {results['n_75']:>3}  ({results['n_75']/n*100:.1f}%)")
    if results["n_75"] > 0:
        print(f"  命中率:  {results['n_correct_75']/results['n_75']*100:.1f}%   ({results['n_correct_75']}/{results['n_75']})")

    print()
    print("=== 80% 条件（更严）===")
    print(f"  触发数:  {results['n_80']:>3}  ({results['n_80']/n*100:.1f}%)")
    if results["n_80"] > 0:
        print(f"  命中率:  {results['n_correct_80']/results['n_80']*100:.1f}%   ({results['n_correct_80']}/{results['n_80']})")

    print()
    print("=== 对比 ===")
    if results["n_80"] > 0 and results["n_75"] > 0:
        acc_75 = results["n_correct_75"]/results["n_75"]
        acc_80 = results["n_correct_80"]/results["n_80"]
        print(f"  触发数:    {results['n_75']} → {results['n_80']}  (Δ={results['n_80']-results['n_75']:+d})")
        print(f"  命中率:    {acc_75*100:.1f}% → {acc_80*100:.1f}%  (Δ={(acc_80-acc_75)*100:+.1f}pp)")


if __name__ == "__main__":
    main()
