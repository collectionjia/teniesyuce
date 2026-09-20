"""
回填选手/英雄数据 (v1.3 增强版)

改进点：
1. 默认 limit 拉到 1000+ 场
2. Player Elo 用真实对手平均 Elo 重算
3. 增量更新（已有数据的场次跳过）
4. 进度条 + 统计报告

用法：
  python scripts/backfill_players.py --limit 1000 --recompute
  python scripts/backfill_players.py --recompute-only  # 只重算 Elo
"""
import sys
import os
import asyncio
import argparse
import math
from datetime import datetime
from collections import defaultdict
from bisect import bisect_left

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dota2elo.db import session_scope, init_db
from dota2elo.models import Team, Match, Player, PlayerMatchStat
from dota2elo.opendota import OpenDotaClient


# =================================================================
# 1. 回填比赛详情（拉 OpenDota）
# =================================================================
async def backfill_players(limit: int = 1000, source: str = "opendota"):
    """回填最近 N 场比赛的选手数据。"""
    init_db()

    with session_scope() as s:
        matches = s.query(Match).filter(
            Match.radiant_team_id.isnot(None),
            Match.dire_team_id.isnot(None),
            Match.radiant_win.isnot(None),
        ).order_by(Match.start_time.desc()).limit(limit).all()
        match_ids = [m.match_id for m in matches]
        print(f"待回填候选: {len(match_ids)} 场 (max {limit})")

        # 已回填的
        existing = set(s.query(PlayerMatchStat.match_id).filter(
            PlayerMatchStat.match_id.in_(match_ids)
        ).all())
        existing = {m for (m,) in existing}
        todo = [mid for mid in match_ids if mid not in existing]
        print(f"已存在: {len(existing)} 场，待拉: {len(todo)} 场")

    if not todo:
        print("无需拉取新数据")
        return

    # 拉数据
    async with OpenDotaClient() as client:
        n_ok = 0
        n_skip = 0
        n_err = 0
        t0 = datetime.now()
        for i, match_id in enumerate(todo):
            try:
                detail = await client.fetch_match(match_id)
                if not detail or not detail.get("players"):
                    n_skip += 1
                    continue
                _save_match_players(detail)
                n_ok += 1
                if (i + 1) % 50 == 0 or i + 1 == len(todo):
                    elapsed = (datetime.now() - t0).total_seconds()
                    rate = (i + 1) / elapsed if elapsed > 0 else 0
                    eta = (len(todo) - i - 1) / rate if rate > 0 else 0
                    print(f"  [{i+1}/{len(todo)}] ok={n_ok} skip={n_skip} err={n_err} "
                          f"({rate:.1f}/s, eta {eta:.0f}s)")
            except Exception as e:
                n_err += 1
                if n_err < 5:
                    print(f"  match {match_id} 失败: {e}")

    print(f"\n回填完成: 成功 {n_ok} / 跳过 {n_skip} / 失败 {n_err}")


def _save_match_players(detail: dict):
    """把单场比赛的 players 写入 DB。"""
    match_id = detail["match_id"]
    players = detail.get("players") or []

    with session_scope() as s:
        for p in players:
            if not p.get("account_id"):
                continue
            account_id = int(p["account_id"])
            player = s.get(Player, account_id)
            if player is None:
                player = Player(
                    id=account_id,
                    name=p.get("name", "") or f"player_{account_id}",
                    current_elo=1500.0,
                    matches_played=0,
                )
                s.add(player)
                s.flush()
            if p.get("won"):
                player.wins = (player.wins or 0) + 1
            else:
                player.losses = (player.losses or 0) + 1
            player.matches_played = (player.matches_played or 0) + 1
            player.last_seen_at = datetime.now()

            stat = PlayerMatchStat(
                match_id=match_id,
                player_id=account_id,
                team_id=p.get("team_id") or 0,
                hero_id=p.get("hero_id", 0) or 0,
                kills=p.get("kills", 0) or 0,
                deaths=p.get("deaths", 0) or 0,
                assists=p.get("assists", 0) or 0,
                gpm=p.get("gpm", 0) or 0,
                xpm=p.get("xpm", 0) or 0,
                net_worth=p.get("net_worth", 0) or 0,
                won=bool(p.get("won")),
                is_radiant=bool(p.get("is_radiant")),
                patch=detail.get("patch"),
            )
            s.add(stat)


# =================================================================
# 2. 重算 Player Elo（用真实对手平均 Elo）
# =================================================================
def recompute_player_elo_with_real_opponents(k_factor: float = 20.0):
    """用真实对手平均 Elo 重算所有 player 的 Elo。

    算法（按时间正序处理每场比赛）：
    1. 取该 player 当前的 Elo
    2. 取该场比赛的对手 5 人中，**比赛前**的 Elo
    3. 计算对手平均 Elo
    4. expected = 1 / (1 + 10^((opp_avg - player_elo) / 400))
    5. player_elo += K * (score - expected)
    """
    print("=" * 60)
    print("重算 Player Elo（用真实对手 Elo）")
    print("=" * 60)
    t0 = datetime.now()

    with session_scope() as s:
        # 1. 加载所有 player 当前的 Elo（作为初值）
        all_players = s.query(Player).all()
        elo_state = {p.id: p.current_elo or 1500.0 for p in all_players}
        print(f"待重算 player: {len(elo_state)}")

        # 2. 加载所有 PlayerMatchStat，按 match_id 升序
        all_stats = s.query(PlayerMatchStat).order_by(
            PlayerMatchStat.match_id
        ).all()
        print(f"待处理 PlayerMatchStat: {len(all_stats)}")

        # 3. 按 match_id 分组（一场比赛 10 个 player stat）
        stats_by_match = defaultdict(list)
        for s_ in all_stats:
            stats_by_match[s_.match_id].append(s_)
        match_ids_sorted = sorted(stats_by_match.keys())

        # 4. 按时间顺序处理
        # 先取每场的比赛时间，用于日志
        match_info = {m.match_id: (m.radiant_team_id, m.dire_team_id, m.radiant_win)
                      for m in s.query(Match).filter(Match.match_id.in_(match_ids_sorted)).all()}

        n_processed = 0
        n_skipped = 0  # 单边比赛（< 5 个对手）
        elo_history = []  # 用于回测

        for match_id in match_ids_sorted:
            stats = stats_by_match[match_id]
            # 按 team 分组
            team_a_stats = [s for s in stats if s.is_radiant]
            team_b_stats = [s for s in stats if not s.is_radiant]

            # 至少一边 5 人
            if len(team_a_stats) < 1 or len(team_b_stats) < 1:
                n_skipped += 1
                continue

            # 对每方：计算对手平均 Elo（当前状态就是"赛前"，因为我们按时间正序处理）
            avg_a = sum(elo_state[s.player_id] for s in team_a_stats) / len(team_a_stats)
            avg_b = sum(elo_state[s.player_id] for s in team_b_stats) / len(team_b_stats)

            # 更新每个 player 的 Elo
            for s_ in team_a_stats:
                p_elo = elo_state[s_.player_id]
                expected = 1.0 / (1.0 + 10 ** ((avg_b - p_elo) / 400.0))
                score = 1.0 if s_.won else 0.0
                delta = k_factor * (score - expected)
                elo_state[s_.player_id] = p_elo + delta
                elo_history.append((s_.player_id, match_id, p_elo + delta, expected, score))

            for s_ in team_b_stats:
                p_elo = elo_state[s_.player_id]
                expected = 1.0 / (1.0 + 10 ** ((avg_a - p_elo) / 400.0))
                score = 1.0 if s_.won else 0.0
                delta = k_factor * (score - expected)
                elo_state[s_.player_id] = p_elo + delta
                elo_history.append((s_.player_id, match_id, p_elo + delta, expected, score))

            n_processed += 1

        # 5. 写回 player.current_elo
        for p in all_players:
            if p.id in elo_state:
                p.current_elo = round(elo_state[p.id], 1)
        s.commit()

        elapsed = (datetime.now() - t0).total_seconds()
        print(f"\n处理完成: {n_processed} 场（{n_skipped} 跳过）")
        print(f"耗时: {elapsed:.1f}s")
        print(f"最终 Elo 分布:")
        if elo_state:
            sorted_elos = sorted(elo_state.values())
            n = len(sorted_elos)
            print(f"  min={sorted_elos[0]:.0f}  p25={sorted_elos[n//4]:.0f}  "
                  f"median={sorted_elos[n//2]:.0f}  p75={sorted_elos[3*n//4]:.0f}  max={sorted_elos[-1]:.0f}")

        # 写一个简短的"player Elo 历史"到 data/player_elo_history.json（v1.4 可视化用）
        import json
        from dota2elo.config import DB_PATH
        out = DB_PATH.parent / "player_elo_history.json"
        with open(out, "w") as f:
            json.dump([
                {"player_id": p, "match_id": m, "elo": e, "expected": x, "score": s}
                for (p, m, e, x, s) in elo_history
            ], f)  # 完整 dump，方便后续分析
        print(f"  写入 {len(elo_history)} 条 Elo 历史到 {out.name}")


# =================================================================
# 3. Top 选手榜（辅助函数）
# =================================================================
def print_top_players(n: int = 20, min_matches: int = 5):
    """打印 Top 选手。"""
    with session_scope() as s:
        players = s.query(Player).filter(
            Player.matches_played >= min_matches
        ).order_by(Player.current_elo.desc()).limit(n).all()
        print(f"\n=== Top {n} 选手 (>= {min_matches} 场) ===")
        for i, p in enumerate(players, 1):
            wr = p.wins / p.matches_played * 100
            print(f"  {i:>3}. {p.name:<30}  Elo={p.current_elo:>7.1f}  "
                  f"{p.matches_played:>3}场  {wr:.0f}%  ({p.wins}W-{p.losses}L)")


# =================================================================
# 入口
# =================================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=1000, help="回填最近 N 场")
    parser.add_argument("--source", default="opendota")
    parser.add_argument("--recompute", action="store_true", help="回填后用真实对手 Elo 重算")
    parser.add_argument("--recompute-only", action="store_true", help="只重算 Elo")
    parser.add_argument("--k", type=float, default=20.0, help="K 因子（默认 20）")
    parser.add_argument("--show-top", type=int, default=0, help="显示 Top N 选手（0=不显示）")
    args = parser.parse_args()

    if not args.recompute_only:
        asyncio.run(backfill_players(limit=args.limit, source=args.source))

    if args.recompute or args.recompute_only:
        recompute_player_elo_with_real_opponents(k_factor=args.k)

    if args.show_top > 0:
        print_top_players(n=args.show_top)


if __name__ == "__main__":
    main()
