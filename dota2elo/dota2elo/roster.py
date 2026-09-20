"""
Roster 工具：从 DB 推断战队的当前阵容。

数据源：PlayerMatchStat（每场比赛的选手记录）
方法：取战队最近一场有数据的比赛，提取 5 个选手作为当前阵容
"""
from __future__ import annotations
from typing import Dict, List, Optional, Tuple
from collections import Counter

from sqlalchemy import desc

from .db import session_scope
from .models import Team, Player, PlayerMatchStat


def get_current_roster(team_id: int, lookback_matches: int = 5) -> Dict[int, float]:
    """取战队最近 lookback_matches 场的 5 个常用选手 + 他们的 Elo。

    算法：取最近 N 场中出现频次 >= N/2 的选手，按出场次数降序取前 5。
    没数据时返回空 dict。

    Args:
        team_id: 战队 ID
        lookback_matches: 看最近 N 场

    Returns:
        {player_id: elo} 字典
    """
    with session_scope() as s:
        # 取最近 N 场该队参与的 match_id
        match_ids = [m.match_id for m in s.query(PlayerMatchStat.match_id)
                     .filter(PlayerMatchStat.team_id == team_id)
                     .order_by(desc(PlayerMatchStat.match_id))
                     .distinct().limit(lookback_matches * 10).all()]
        match_ids = match_ids[:lookback_matches]
        if not match_ids:
            return {}

        # 统计每个 player 在这些比赛中的出现次数
        rows = s.query(PlayerMatchStat).filter(
            PlayerMatchStat.team_id == team_id,
            PlayerMatchStat.match_id.in_(match_ids)
        ).all()

        counter = Counter(r.player_id for r in rows)
        # 至少出现 N/2 次
        threshold = max(1, len(match_ids) // 2)
        top5 = [pid for pid, cnt in counter.most_common(5) if cnt >= threshold]
        if not top5:
            # 如果没达到阈值，退化到出现最多的
            top5 = [pid for pid, _ in counter.most_common(5)]

        # 取 Elo
        players = s.query(Player).filter(Player.id.in_(top5)).all()
        return {p.id: p.current_elo for p in players}


def get_team_recent_players_with_names(team_id: int, lookback: int = 5
                                       ) -> List[Tuple[int, str, float, int]]:
    """取战队最近常用选手的详情列表。

    Returns:
        [(player_id, name, elo, matches), ...]  按 Elo 降序
    """
    roster = get_current_roster(team_id, lookback_matches=lookback)
    if not roster:
        return []
    with session_scope() as s:
        players = s.query(Player).filter(Player.id.in_(roster.keys())).all()
        # 拿每个选手的 matches_played
        result = []
        for p in players:
            result.append((p.id, p.name, p.current_elo, p.matches_played))
        return sorted(result, key=lambda x: -x[2])


def build_teamrating_with_roster(team_id: int, team_name: str, team_elo: float,
                                  games: int, lookback: int = 5):
    """构造带 player_elo 的 TeamRating。"""
    from .elo import TeamRating
    roster = get_current_roster(team_id, lookback_matches=lookback)
    return TeamRating(
        team_id=team_id,
        name=team_name,
        team_elo=team_elo,
        games=games,
        player_elo=roster,
    )
