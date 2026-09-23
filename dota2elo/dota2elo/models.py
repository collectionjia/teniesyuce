"""ORM 模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Team(Base):
    """战队主表。"""

    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # OpenDota team_id
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    tag: Mapped[Optional[str]] = mapped_column(String(20))
    logo_url: Mapped[Optional[str]] = mapped_column(Text)
    rating: Mapped[float] = mapped_column(Float, default=1500.0, nullable=False)
    matches_played: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    wins: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    losses: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_match_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime)

    # v1.6: per-tier Elo（按对手联赛层级分桶更新，避免跨层级 Elo 偏差）
    elo_t1: Mapped[float] = mapped_column(Float, default=1500.0, nullable=False)
    elo_t2: Mapped[float] = mapped_column(Float, default=1500.0, nullable=False)
    elo_t3: Mapped[float] = mapped_column(Float, default=1500.0, nullable=False)
    elo_t4: Mapped[float] = mapped_column(Float, default=1500.0, nullable=False)
    games_t1: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    games_t2: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    games_t3: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    games_t4: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Match(Base):
    """职业比赛记录。"""

    __tablename__ = "matches"
    __table_args__ = (
        UniqueConstraint("match_id", name="uq_match_id"),
        Index("ix_match_start_time", "start_time"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    match_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    start_time: Mapped[Optional[datetime]] = mapped_column(DateTime)
    duration_sec: Mapped[Optional[int]] = mapped_column(Integer)
    league_id: Mapped[Optional[int]] = mapped_column(Integer)
    league_name: Mapped[Optional[str]] = mapped_column(String(200), index=True)
    series_type: Mapped[Optional[str]] = mapped_column(String(20))  # bo1/bo3/bo5
    radiant_team_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("teams.id"))
    dire_team_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("teams.id"))
    radiant_score: Mapped[Optional[int]] = mapped_column(Integer)
    dire_score: Mapped[Optional[int]] = mapped_column(Integer)
    radiant_win: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Elo 计算快照（重算时可追溯）
    k_factor: Mapped[Optional[float]] = mapped_column(Float)
    elo_change_radiant: Mapped[Optional[float]] = mapped_column(Float)
    elo_change_dire: Mapped[Optional[float]] = mapped_column(Float)


class RatingHistory(Base):
    """每场比赛后每队的 Elo 快照。"""

    __tablename__ = "rating_history"
    __table_args__ = (
        Index("ix_rating_team_time", "team_id", "recorded_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    team_id: Mapped[int] = mapped_column(Integer, ForeignKey("teams.id"), nullable=False)
    match_id: Mapped[int] = mapped_column(Integer, ForeignKey("matches.match_id"), nullable=False)
    elo_before: Mapped[float] = mapped_column(Float, nullable=False)
    elo_after: Mapped[float] = mapped_column(Float, nullable=False)
    opponent_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("teams.id"))
    result: Mapped[str] = mapped_column(String(1), nullable=False)  # W / L
    k_factor: Mapped[float] = mapped_column(Float, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class Player(Base):
    """职业选手（OpenDota account_id）。"""
    __tablename__ = "players"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)  # OpenDota account_id (64-bit)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    current_elo: Mapped[float] = mapped_column(Float, default=1500.0, nullable=False)
    matches_played: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    wins: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    losses: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime)


class TeamPlayer(Base):
    """战队-选手关联（roster 记录）。"""
    __tablename__ = "team_players"
    __table_args__ = (
        Index("ix_team_player_team", "team_id"),
        Index("ix_team_player_player", "player_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    team_id: Mapped[int] = mapped_column(Integer, ForeignKey("teams.id"), nullable=False)
    player_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("players.id"), nullable=False)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime)  # null = 当前仍是该队


class PlayerMatchStat(Base):
    """单场比赛的选手表现。"""
    __tablename__ = "player_match_stats"
    __table_args__ = (
        UniqueConstraint("match_id", "player_id", name="uq_player_match"),
        Index("ix_pms_player", "player_id"),
        Index("ix_pms_team", "team_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    match_id: Mapped[int] = mapped_column(Integer, ForeignKey("matches.match_id"), nullable=False)
    player_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("players.id"), nullable=False)
    team_id: Mapped[int] = mapped_column(Integer, ForeignKey("teams.id"), nullable=False)
    hero_id: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    kills: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    deaths: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    assists: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    gpm: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    xpm: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    net_worth: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    won: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_radiant: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    patch: Mapped[Optional[int]] = mapped_column(Integer)  # patch number


class SourceCache(Base):
    """数据源响应缓存（match/team 元数据）。

    同一 match_id / team_id 的远端响应在 TTL 内复用，避免重复调用 API。
    """
    __tablename__ = "source_cache"
    __table_args__ = (
        Index("ix_cache_key", "cache_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)  # JSON
    fetched_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class IngestJob(Base):
    """后台 ingest 任务状态（仅当前进程内存也写一行落盘，方便重启追溯）。"""

    __tablename__ = "ingest_jobs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)  # uuid
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    max_pages: Mapped[int] = mapped_column(Integer, nullable=False)
    enrich_top_n: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # pending/running/done/error
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    result: Mapped[Optional[str]] = mapped_column(Text)  # JSON
    error: Mapped[Optional[str]] = mapped_column(Text)
