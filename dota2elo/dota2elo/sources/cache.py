"""数据源响应缓存。

`CachedSource` 包装任意 `MatchSource`，对 `fetch_match` / `fetch_team`
按 (kind, id) 做持久化缓存，避免重复远端调用。

- 命中：直接返回缓存中的规范化字典
- 未命中：调底层源、写入缓存、返回
- TTL：match 1 小时（新生比赛元数据可能更新），team 24 小时（基本不变）
- `iter_pro_matches` 不缓存（列表太长且每次会变）

开启/关闭：
- 环境变量 `DOTA2ELO_CACHE=0` 可关闭
- 默认开启，缓存表 source_cache 会自动创建
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from ..db import session_scope
from ..models import SourceCache
from . import MatchSource

logger = logging.getLogger(__name__)


CACHE_ENABLED = os.getenv("DOTA2ELO_CACHE", "1") not in ("0", "false", "no")
MATCH_TTL = timedelta(hours=1)
TEAM_TTL = timedelta(hours=24)


def _now() -> datetime:
    return datetime.utcnow()


def _key(kind: str, obj_id: int) -> str:
    return f"{kind}:{obj_id}"


def _get(key: str) -> Optional[Dict[str, Any]]:
    if not CACHE_ENABLED:
        return None
    with session_scope() as session:
        row = session.query(SourceCache).filter(SourceCache.cache_key == key).one_or_none()
        if not row:
            return None
        if row.expires_at < _now():
            return None
        try:
            return json.loads(row.payload)
        except json.JSONDecodeError:
            return None


def _put(key: str, source: str, payload: Dict[str, Any], ttl: timedelta) -> None:
    if not CACHE_ENABLED:
        return
    expires = _now() + ttl
    body = json.dumps(payload, default=str)
    with session_scope() as session:
        existing = session.query(SourceCache).filter(SourceCache.cache_key == key).one_or_none()
        if existing:
            existing.source = source
            existing.payload = body
            existing.fetched_at = _now()
            existing.expires_at = expires
        else:
            session.add(SourceCache(
                cache_key=key, source=source, payload=body,
                fetched_at=_now(), expires_at=expires,
            ))


def cache_stats() -> Dict[str, int]:
    """当前缓存条目数 + 即将过期数。"""
    with session_scope() as session:
        total = session.query(SourceCache).count()
        soon = session.query(SourceCache).filter(SourceCache.expires_at < _now()).count()
    return {"total": total, "expired": soon}


def clear_cache() -> int:
    with session_scope() as session:
        n = session.query(SourceCache).delete()
    return n


class CachedSource:
    """装饰任意 MatchSource，自动加缓存。"""

    name = "cached"

    def __init__(self, inner: MatchSource, match_ttl: timedelta = MATCH_TTL, team_ttl: timedelta = TEAM_TTL):
        self.inner = inner
        self.inner_name = getattr(inner, "name", inner.__class__.__name__.lower())
        self.match_ttl = match_ttl
        self.team_ttl = team_ttl
        self.hits = 0
        self.misses = 0

    async def __aenter__(self) -> "CachedSource":
        if hasattr(self.inner, "__aenter__"):
            await self.inner.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        try:
            await self.inner.aclose()
        except Exception:  # noqa: BLE001
            pass

    async def iter_pro_matches(self, max_pages: int = 50) -> List[Dict[str, Any]]:
        # 列表不缓存
        return await self.inner.iter_pro_matches(max_pages=max_pages)

    async def fetch_match(self, match_id: int) -> Optional[Dict[str, Any]]:
        key = _key("match", match_id)
        cached = _get(key)
        if cached is not None:
            self.hits += 1
            return cached
        self.misses += 1
        data = await self.inner.fetch_match(match_id)
        if data is not None:
            _put(key, self.inner.name, data, self.match_ttl)
        return data

    async def fetch_team(self, team_id: int) -> Optional[Dict[str, Any]]:
        key = _key("team", team_id)
        cached = _get(key)
        if cached is not None:
            self.hits += 1
            return cached
        self.misses += 1
        data = await self.inner.fetch_team(team_id)
        if data is not None:
            _put(key, self.inner.name, data, self.team_ttl)
        return data
