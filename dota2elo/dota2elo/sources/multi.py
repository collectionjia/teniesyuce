"""多源调度器：主源失败时按顺序回退。"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from . import MatchSource

logger = logging.getLogger(__name__)


class MultiSourceClient:
    """按优先级顺序尝试数据源；任一成功即返回，全失败才报错。

    用法:
        client = MultiSourceClient([stratz_c, opendota_c])
        matches = await client.iter_pro_matches()
    """

    name = "multi"

    def __init__(self, sources: List[MatchSource]):
        if not sources:
            raise ValueError("MultiSourceClient 至少需要 1 个数据源")
        self.sources = list(sources)

    async def __aenter__(self) -> "MultiSourceClient":
        for s in self.sources:
            # 兼容 context manager 接口
            if hasattr(s, "__aenter__"):
                await s.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        for s in self.sources:
            try:
                await s.aclose()
            except Exception:  # noqa: BLE001
                pass

    async def iter_pro_matches(self, max_pages: int = 50) -> List[Dict[str, Any]]:
        last_exc: Optional[Exception] = None
        for s in self.sources:
            try:
                data = await s.iter_pro_matches(max_pages=max_pages)
                if data:
                    logger.info("iter_pro_matches 命中 %s，返回 %d 场", s.name, len(data))
                    return data
                logger.warning("数据源 %s 返回空，尝试下一个", s.name)
            except Exception as e:  # noqa: BLE001
                last_exc = e
                logger.warning("数据源 %s 失败：%s，尝试下一个", s.name, e)
        if last_exc:
            raise last_exc
        return []

    async def fetch_match(self, match_id: int) -> Optional[Dict[str, Any]]:
        for s in self.sources:
            try:
                data = await s.fetch_match(match_id)
                if data:
                    logger.debug("fetch_match(%s) 命中 %s", match_id, s.name)
                    return data
            except Exception as e:  # noqa: BLE001
                logger.warning("数据源 %s.fetch_match(%s) 失败：%s", s.name, match_id, e)
        return None

    async def fetch_team(self, team_id: int) -> Optional[Dict[str, Any]]:
        for s in self.sources:
            try:
                data = await s.fetch_team(team_id)
                if data:
                    logger.debug("fetch_team(%s) 命中 %s", team_id, s.name)
                    return data
            except Exception as e:  # noqa: BLE001
                logger.warning("数据源 %s.fetch_team(%s) 失败：%s", s.name, team_id, e)
        return None
