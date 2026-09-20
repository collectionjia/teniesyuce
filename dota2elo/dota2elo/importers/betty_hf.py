"""从 Betty Dota2 Pro Matches Dataset 导入。

数据集：https://huggingface.co/datasets/wolframko/pipes-lie-embargo-dominus
- 9388 场 2025 职业比赛
- 字段：match_id, league_name, league_tier, duration_sec, radiant_win,
       radiant_team_id, dire_team_id, p0..p9_*, stratz_pb_hero_id, ...
- MIT 许可

注意：本数据集**不包含** start_time 和 team 名称，只给 ID。
- match_id 跟 OpenDota 同一编号空间，已存在会自动去重
- team 名需要从已有数据查找，找不到的用 fallback "Team {id}"
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import session_scope, init_db
from ..ingest import recompute_all_ratings
from ..models import Match, Team

logger = logging.getLogger(__name__)


# 必需字段
REQUIRED = ["match_id", "radiant_win", "duration_sec", "radiant_team_id", "dire_team_id"]
# 可选字段
LEAGUE_FIELD_CANDIDATES = ["league_name", "league_tier"]
START_TIME_CANDIDATES = ["start_time", "start_date_time", "match_start_time", "timestamp"]


def _read_parquet(path: Path) -> List[Dict]:
    """读 parquet 兼容多种库。"""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        try:
            import pandas as pd
        except ImportError as e:
            raise ImportError(
                "读 .parquet 需要 pyarrow 或 pandas。先 pip install pyarrow"
            ) from e
        df = pd.read_parquet(path)
        return df.to_dict(orient="records")
    t = pq.read_table(str(path))
    return t.to_pylist()


def import_betty(parquet_path: str | Path) -> Dict[str, int]:
    """从 Betty matches.parquet 导入。返回统计。"""
    p = Path(parquet_path)
    if not p.exists():
        raise FileNotFoundError(f"找不到 {p}")

    rows = _read_parquet(p)
    if not rows:
        return {"source": "betty-hf", "new_matches": 0, "teams_added": 0}

    # 检测字段
    sample = rows[0]
    league_field = next((f for f in LEAGUE_FIELD_CANDIDATES if f in sample), None)
    start_time_field = next((f for f in START_TIME_CANDIDATES if f in sample), None)
    missing_required = [f for f in REQUIRED if f not in sample]
    if missing_required:
        raise ValueError(f"parquet 缺少必需字段: {missing_required}")
    logger.info(
        "Betty 字段: league_field=%s, start_time_field=%s, rows=%d",
        league_field, start_time_field, len(rows),
    )

    init_db()
    with session_scope() as session:
        existing_match_ids = {m for m in session.scalars(select(Match.match_id)).all()}
        existing_team_ids = {t.id for t in session.scalars(select(Team)).all()}

        teams_added = 0
        for r in rows:
            for tid in (r.get("radiant_team_id"), r.get("dire_team_id")):
                if tid and tid not in existing_team_ids:
                    session.add(Team(
                        id=tid,
                        name=f"Team {tid}",  # Betty 没给名字，后续 enrich 补
                        tag=None,
                    ))
                    existing_team_ids.add(tid)
                    teams_added += 1

        new_matches = 0
        skipped = 0
        for r in rows:
            mid = r.get("match_id")
            if not mid or mid in existing_match_ids:
                continue
            r_id = r.get("radiant_team_id")
            d_id = r.get("dire_team_id")
            if not r_id or not d_id:
                skipped += 1
                continue

            # start_time 转换（如果有）
            from datetime import datetime, timezone
            start_dt = None
            if start_time_field:
                v = r.get(start_time_field)
                if v is not None:
                    try:
                        if isinstance(v, (int, float)):
                            start_dt = datetime.fromtimestamp(int(v), tz=timezone.utc).replace(tzinfo=None)
                        elif isinstance(v, str):
                            start_dt = datetime.fromisoformat(v.replace("Z", "+00:00")).replace(tzinfo=None)
                    except Exception:
                        start_dt = None

            session.add(Match(
                match_id=int(mid),
                start_time=start_dt,
                duration_sec=int(r.get("duration_sec") or 0),
                league_id=None,
                league_name=str(r.get(league_field)) if league_field else None,
                series_type="bo1",
                radiant_team_id=int(r_id),
                dire_team_id=int(d_id),
                radiant_score=0,  # Betty 没给 score
                dire_score=0,
                radiant_win=bool(r.get("radiant_win")),
            ))
            new_matches += 1

    elo_stats = recompute_all_ratings()
    return {
        "source": "betty-hf",
        "parquet": str(p),
        "rows_in_file": len(rows),
        "teams_added": teams_added,
        "new_matches": new_matches,
        "skipped": skipped,
        **elo_stats,
    }
