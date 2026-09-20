"""数据拉取 + Elo 全量重算。"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import (
    DEFAULT_SOURCE,
    INITIAL_ELO,
    PROVISIONAL_MATCHES,
    STRATZ_API_KEY,
    k_factor_for_league,
)
from .elo import k_factor

from .db import SessionLocal, init_db, session_scope
from .elo import update_ratings
from .models import Match, RatingHistory, Team
from .opendota import OpenDotaClient
from .sources import MatchSource
from .sources.cache import CachedSource
from .sources.multi import MultiSourceClient
from .stratz import StratzClient

logger = logging.getLogger(__name__)


# ----------------------------- 同步辅助 ----------------------------- #
def _ts_to_dt(ts: Optional[int]) -> Optional[datetime]:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)


def _ensure_team(session: Session, team_id: int, name_hint: Optional[str] = None) -> Team:
    team = session.get(Team, team_id)
    if team is None:
        team = Team(
            id=team_id,
            name=name_hint or f"Team {team_id}",
            tag=None,
            rating=INITIAL_ELO,
            matches_played=0,
            wins=0,
            losses=0,
        )
        session.add(team)
        session.flush()
    return team


def _team_name_from_pro(pro: dict, slot: str) -> Optional[str]:
    """规范化 dict 字段：{slot}_name。"""
    return pro.get(f"{slot}_name") or pro.get(f"{slot}_team_name")


# ----------------------------- 数据源工厂 ----------------------------- #
def build_source(spec: Optional[str] = None, use_cache: bool = True) -> MatchSource:
    """根据 spec 构造数据源（自动套缓存层）。

    spec:
      - None / "auto": 配了 STRATZ_API_KEY 就 Stratz 优先 + OpenDota 兜底；否则只用 OpenDota
      - "opendota":     仅 OpenDota
      - "stratz":       仅 Stratz（需要 API key）
      - "multi":        Stratz 优先 + OpenDota 兜底（强制多源）
    """
    spec = (spec or DEFAULT_SOURCE or "auto").lower()
    if spec == "opendota":
        inner: MatchSource = OpenDotaClient()
    elif spec == "stratz":
        if not STRATZ_API_KEY:
            raise ValueError("spec=stratz 但未设置 STRATZ_API_KEY 环境变量")
        inner = StratzClient()
    elif spec == "multi":
        if not STRATZ_API_KEY:
            raise ValueError("spec=multi 但未设置 STRATZ_API_KEY 环境变量")
        inner = MultiSourceClient([StratzClient(), OpenDotaClient()])
    else:  # auto
        if STRATZ_API_KEY:
            inner = MultiSourceClient([StratzClient(), OpenDotaClient()])
        else:
            inner = OpenDotaClient()
    if use_cache:
        return CachedSource(inner)
    return inner


# ----------------------------- 主流程 ----------------------------- #
def upsert_pro_match_list(session: Session, pro_list: List[dict]) -> int:
    """把 proMatches 列表写入库：只写元数据，不计算 Elo。
    返回新增/更新的 Match 行数。
    """
    if not pro_list:
        return 0
    affected = 0
    for pro in pro_list:
        match_id = pro.get("match_id")
        if not match_id:
            continue
        existing = session.scalar(select(Match).where(Match.match_id == match_id))
        if existing:
            continue  # 已存在则跳过元数据更新（避免覆盖 Elo 计算结果）

        radiant_team_id = pro.get("radiant_team_id") or pro.get("team_id_radiant")
        dire_team_id = pro.get("dire_team_id") or pro.get("team_id_dire")
        if not radiant_team_id or not dire_team_id:
            # 没有战队信息（占位/匿名局）跳过
            continue

        # 确保战队存在
        r_name = _team_name_from_pro(pro, "radiant")
        d_name = _team_name_from_pro(pro, "dire")
        _ensure_team(session, radiant_team_id, r_name)
        _ensure_team(session, dire_team_id, d_name)

        match = Match(
            match_id=match_id,
            start_time=_ts_to_dt(pro.get("start_time")),
            duration_sec=pro.get("duration"),
            league_id=pro.get("league_id"),
            league_name=pro.get("league_name"),
            series_type=pro.get("series_type") or "bo1",
            radiant_team_id=radiant_team_id,
            dire_team_id=dire_team_id,
            radiant_score=pro.get("radiant_score") or 0,
            dire_score=pro.get("dire_score") or 0,
            radiant_win=bool(pro.get("radiant_win", False)),
        )
        session.add(match)
        affected += 1
    session.flush()
    return affected


def recompute_all_ratings() -> Dict[str, int]:
    """全量重算 Elo：按时间顺序遍历所有比赛。
    返回处理统计。
    """
    init_db()
    with session_scope() as session:
        # 1) 重置所有队伍 Elo
        teams = session.scalars(select(Team)).all()
        for t in teams:
            t.rating = INITIAL_ELO
            t.matches_played = 0
            t.wins = 0
            t.losses = 0
            t.last_match_at = None

        # 2) 删旧 rating_history
        session.query(RatingHistory).delete()
        session.flush()

        # 3) 按时间顺序取出比赛
        matches = session.scalars(
            select(Match)
            .where(Match.radiant_team_id.is_not(None), Match.dire_team_id.is_not(None))
            .order_by(Match.start_time.asc().nulls_last(), Match.match_id.asc())
        ).all()

        processed = 0
        skipped = 0
        for m in matches:
            r_team = session.get(Team, m.radiant_team_id)
            d_team = session.get(Team, m.dire_team_id)
            if not r_team or not d_team:
                skipped += 1
                continue
            k = k_factor(series_type=m.series_type, league_name=m.league_name)
            score_a = 1.0 if m.radiant_win else 0.0
            # v1.5 tier-aware K 因子（按联赛层级调整 Elo 更新幅度）
            from .league_tiers import get_tier
            tier_a = get_tier(league_id=m.league_id, league_name=m.league_name)
            tier_b = tier_a  # 同一联赛
            new_r, new_d, e_r, k_used = update_ratings(
                r_team.rating,
                d_team.rating,
                score_a,
                base_k=k,
                matches_played_a=r_team.matches_played,
                matches_played_b=d_team.matches_played,
                tier_a=tier_a,
                tier_b=tier_b,
            )

            old_r, old_d = r_team.rating, d_team.rating
            r_team.rating = new_r
            d_team.rating = new_d
            r_team.matches_played += 1
            d_team.matches_played += 1
            if m.radiant_win:
                r_team.wins += 1
                d_team.losses += 1
            else:
                d_team.wins += 1
                r_team.losses += 1
            if m.start_time:
                r_team.last_match_at = m.start_time
                d_team.last_match_at = m.start_time

            m.k_factor = k_used
            m.elo_change_radiant = new_r - old_r
            m.elo_change_dire = new_d - old_d

            when = m.start_time or datetime.utcnow()
            session.add_all([
                RatingHistory(
                    team_id=r_team.id, match_id=m.match_id,
                    elo_before=old_r, elo_after=new_r,
                    opponent_id=d_team.id, result="W" if m.radiant_win else "L",
                    k_factor=k_used, recorded_at=when,
                ),
                RatingHistory(
                    team_id=d_team.id, match_id=m.match_id,
                    elo_before=old_d, elo_after=new_d,
                    opponent_id=r_team.id, result="L" if m.radiant_win else "W",
                    k_factor=k_used, recorded_at=when,
                ),
            ])
            processed += 1

        return {
            "teams": len(teams),
            "matches_processed": processed,
            "matches_skipped": skipped,
        }


def full_ingest(max_pages: int = 20, enrich_top_n: int = 50, source: Optional[str] = None) -> Dict[str, int]:
    """一键流程：拉取 proMatches -> 写库 -> 拉战队元数据 -> 全量重算 Elo。

    source: None/auto | opendota | stratz | multi
    """
    init_db()
    src = build_source(source)
    used_source = getattr(src, "inner_name", src.name)

    async def _all() -> Dict[str, int]:
        pro_list = await src.iter_pro_matches(max_pages=max_pages)
        # 同步 DB 写入（SQLAlchemy Session 本身是同步的）
        with session_scope() as session:
            new_matches = upsert_pro_match_list(session, pro_list)
            rows = session.execute(
                select(Team.id).order_by(Team.id).limit(enrich_top_n)
            ).scalars().all()
            team_ids = list(rows)
        # 拉战队元数据（仍用 src）
        team_meta: Dict[int, Dict] = {}
        for tid in team_ids:
            data = await src.fetch_team(tid)
            if data:
                team_meta[tid] = data
        with session_scope() as session:
            for tid, data in team_meta.items():
                t = session.get(Team, tid)
                if not t:
                    continue
                if data.get("name"):
                    t.name = data["name"]
                if data.get("tag"):
                    t.tag = data["tag"]
                if data.get("logo_url"):
                    t.logo_url = data["logo_url"]
                t.last_synced_at = datetime.utcnow()
            session.flush()
        return {
            "pro_pulled": len(pro_list),
            "new_matches": new_matches,
            "teams_enriched": len(team_meta),
        }

    stats = asyncio.run(_all())
    elo_stats = recompute_all_ratings()
    elo_stats.update(stats)
    elo_stats["source"] = used_source
    return elo_stats


def predict_match(team_a_id: int, team_b_id: int) -> Optional[Dict[str, float]]:
    """基于当前 Elo 预测两队胜负。"""
    from .elo import expected_win
    with session_scope() as session:
        a = session.get(Team, team_a_id)
        b = session.get(Team, team_b_id)
        if not a or not b:
            return None
        p_a = expected_win(a.rating, b.rating)
        p_b = 1.0 - p_a
        return {
            "team_a_id": a.id,
            "team_a_name": a.name,
            "team_a_rating": round(a.rating, 1),
            "team_b_id": b.id,
            "team_b_name": b.name,
            "team_b_rating": round(b.rating, 1),
            "p_a_win": round(p_a, 4),
            "p_b_win": round(p_b, 4),
        }


def team_history(team_id: int, limit: int = 50) -> List[Dict]:
    """获取战队 Elo 历史。"""
    with session_scope() as session:
        team = session.get(Team, team_id)
        if not team:
            return []
        rows = session.scalars(
            select(RatingHistory)
            .where(RatingHistory.team_id == team_id)
            .order_by(RatingHistory.recorded_at.asc())
        ).all()
        out = []
        for r in rows:
            out.append({
                "match_id": r.match_id,
                "elo_before": round(r.elo_before, 1),
                "elo_after": round(r.elo_after, 1),
                "result": r.result,
                "k_factor": r.k_factor,
                "recorded_at": r.recorded_at.isoformat() if r.recorded_at else None,
                "opponent_id": r.opponent_id,
            })
        return out


def find_team(query: str) -> List[Dict]:
    """按名称/id 模糊查询战队。"""
    with session_scope() as session:
        from sqlalchemy import or_, cast, String
        q = f"%{query.lower()}%"
        rows = session.scalars(
            select(Team).where(
                or_(
                    cast(Team.name, String).ilike(q),
                    cast(Team.id, String).like(q),
                )
            ).order_by(Team.rating.desc()).limit(20)
        ).all()
        return [
            {
                "id": t.id,
                "name": t.name,
                "tag": t.tag,
                "rating": round(t.rating, 1),
                "matches_played": t.matches_played,
                "wins": t.wins,
                "losses": t.losses,
            }
            for t in rows
        ]


def rankings(limit: int = 100) -> List[Dict]:
    with session_scope() as session:
        rows = session.scalars(
            select(Team)
            .where(Team.matches_played > 0)
            .order_by(Team.rating.desc())
            .limit(limit)
        ).all()
        return [
            {
                "id": t.id,
                "name": t.name,
                "tag": t.tag,
                "logo_url": t.logo_url,
                "rating": round(t.rating, 1),
                "matches_played": t.matches_played,
                "wins": t.wins,
                "losses": t.losses,
                "win_rate": round(t.wins / t.matches_played, 4) if t.matches_played else 0.0,
                "last_match_at": t.last_match_at.isoformat() if t.last_match_at else None,
            }
            for t in rows
        ]


def recent_matches(limit: int = 50) -> List[Dict]:
    with session_scope() as session:
        rows = session.scalars(
            select(Match)
            .where(Match.radiant_team_id.is_not(None))
            .order_by(Match.start_time.desc().nulls_last())
            .limit(limit)
        ).all()
        result = []
        for m in rows:
            r = session.get(Team, m.radiant_team_id)
            d = session.get(Team, m.dire_team_id)
            result.append({
                "match_id": m.match_id,
                "start_time": m.start_time.isoformat() if m.start_time else None,
                "league_name": m.league_name,
                "radiant_name": r.name if r else f"#{m.radiant_team_id}",
                "dire_name": d.name if d else f"#{m.dire_team_id}",
                "radiant_team_id": m.radiant_team_id,
                "dire_team_id": m.dire_team_id,
                "radiant_win": m.radiant_win,
                "radiant_score": m.radiant_score,
                "dire_score": m.dire_score,
                "k_factor": m.k_factor,
            })
        return result
