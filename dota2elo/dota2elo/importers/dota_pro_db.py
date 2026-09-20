"""从 dota-pro-db 预构建 SQLite 导入历史 T1 比赛数据。

来源：https://github.com/dca123/dota-pro-db/releases
每周发布一次完整 T1 比赛快照（~6MB SQLite），覆盖 Liquipedia 标 T1 的所有联赛。

导入后会自动去重（match_id 跟 OpenDota 同一编号空间，已有的不重复），
然后用全量 Elo 重算把历史 Elo 补齐。
"""
from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import session_scope, init_db
from ..ingest import recompute_all_ratings
from ..models import Match, Team

logger = logging.getLogger(__name__)


def _ts_to_dt(ts: Optional[int]) -> Optional[datetime]:
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).replace(tzinfo=None)


def import_dota_pro_db(db_path: str | Path) -> Dict[str, int]:
    """从 dota-pro-db SQLite 导入比赛和战队。返回统计。"""
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"找不到 {db_path}")

    init_db()
    src = sqlite3.connect(str(db_path))
    src.row_factory = sqlite3.Row
    try:
        # 1) 拉取联赛名
        league_names: Dict[int, str] = {
            row["id"]: row["name"] for row in src.execute("SELECT id, name FROM leagues")
        }
        # 2) 拉战队（如果当前 DB 没建，先建）
        teams_added = 0
        with session_scope() as session:
            existing_team_ids = {t.id for t in session.scalars(select(Team)).all()}
            for row in src.execute("SELECT id, name, tag FROM teams"):
                if row["id"] in existing_team_ids:
                    continue
                session.add(Team(
                    id=row["id"],
                    name=row["name"] or f"Team {row['id']}",
                    tag=row["tag"] or None,
                ))
                teams_added += 1
        # 3) 拉系列赛（Bo3/Bo5 比分，用于 series_score）
        series_scores: Dict[int, tuple] = {}
        for row in src.execute(
            "SELECT id, team_one_id, team_two_id, team_one_win_count, team_two_win_count "
            "FROM series"
        ):
            series_scores[row["id"]] = (
                row["team_one_id"], row["team_two_id"],
                row["team_one_win_count"], row["team_two_win_count"],
            )

        # 4) 拉比赛，按时间排序（用 OpenDota 同名 match_id 编号）
        new_matches = 0
        skipped_no_teams = 0
        with session_scope() as session:
            existing_match_ids = {
                m for m in session.scalars(select(Match.match_id)).all()
            }
            for row in src.execute("""
                SELECT id, did_radiant_win, duration_seconds, start_date_time,
                       league_id, series_id, radiant_team_id, dire_team_id
                FROM matches
                ORDER BY start_date_time ASC
            """):
                mid = row["id"]
                if mid in existing_match_ids:
                    continue
                r_id, d_id = row["radiant_team_id"], row["dire_team_id"]
                if not r_id or not d_id:
                    skipped_no_teams += 1
                    continue

                # 从 series 拿 Bo 比分
                r_score, d_score = None, None
                ser = series_scores.get(row["series_id"])
                if ser:
                    s_r_id, s_d_id, r_wins, d_wins = ser
                    # series 里 team_one/dire 的对应关系可能跟 match 不一致，
                    # 需要用 match 自己的 r_id/d_id 来匹配
                    if s_r_id == r_id and s_d_id == d_id:
                        r_score, d_score = r_wins, d_wins
                    elif s_r_id == d_id and s_d_id == r_id:
                        r_score, d_score = d_wins, r_wins

                session.add(Match(
                    match_id=mid,
                    start_time=_ts_to_dt(row["start_date_time"]),
                    duration_sec=row["duration_seconds"],
                    league_id=row["league_id"],
                    league_name=league_names.get(row["league_id"], f"League#{row['league_id']}"),
                    series_type="bo1",  # dota-pro-db 的 series 是 Bo3/Bo5，单 match 按 Bo1 入
                    radiant_team_id=r_id,
                    dire_team_id=d_id,
                    radiant_score=r_score if r_score is not None else 0,
                    dire_score=d_score if d_score is not None else 0,
                    radiant_win=bool(row["did_radiant_win"]),
                ))
                new_matches += 1
        # 5) 全量重算 Elo
        elo_stats = recompute_all_ratings()
        return {
            "source": "dota-pro-db",
            "db_path": str(db_path),
            "teams_added": teams_added,
            "new_matches": new_matches,
            "skipped_no_teams": skipped_no_teams,
            **elo_stats,
        }
    finally:
        src.close()
