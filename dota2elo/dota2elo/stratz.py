"""Stratz GraphQL 客户端（备选/主数据源）。

免费 tier 需注册 https://stratz.com/api 拿 token，设环境变量：
    export STRATZ_API_KEY=xxx

Stratz 通过 GraphQL 提供职业比赛、战队、英雄 BP 等更丰富的数据。
本客户端把所有响应**规范化**到与 OpenDota 一致的字段（见 sources/__init__.py），
方便上层 ingest 统一处理。

注意：Stratz 的 GraphQL schema 版本可能微调，下面 query 字段名按当前
公开文档写，如未来变化只需改 QUERY_* 字符串即可。
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

from .config import STRATZ_API_KEY, STRATZ_RATE_LIMIT_SECONDS, STRATZ_URL
from .sources import MatchSource

logger = logging.getLogger(__name__)

SOURCE_NAME = "stratz"


# --------------------------- GraphQL Queries --------------------------- #
# 拉取最近 N 场职业比赛（按开始时间倒序）
QUERY_PRO_MATCHES = """
query ProMatches($take: Int!, $skip: Int!) {
  matches(
    request: {
      take: $take
      skip: $skip
      isProfessional: true
      orderBy: START_DATE_TIME_DESC
    }
  ) {
    id
    startDateTime
    durationSeconds
    league { id name }
    radiantTeam { id name tag }
    direTeam { id name tag }
    series { type }
    didRadiantWin
    radiantScore
    direScore
  }
}
"""

# 单场比赛详情
QUERY_MATCH = """
query MatchDetail($id: Long!) {
  match(id: $id) {
    id
    startDateTime
    durationSeconds
    league { id name }
    radiantTeam { id name tag }
    direTeam { id name tag }
    series { type }
    didRadiantWin
    radiantScore
    direScore
  }
}
"""

# 战队元数据
QUERY_TEAM = """
query TeamDetail($id: Int!) {
  team(id: $id) {
    id
    name
    tag
    logo
  }
}
"""


# --------------------------- 规范化辅助 --------------------------- #
def _parse_start_time(v: Any) -> Optional[int]:
    """Stratz 可能返回 ISO8601 字符串或 epoch 秒，统一为 epoch 秒。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        # ISO8601: 2024-08-25T12:00:00Z 或带时区
        try:
            # python 3.9 没有 fromisoformat 的 Z 支持，手动替换
            s = v.replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            return int(dt.timestamp())
        except Exception:
            return None
    return None


def _norm_pro_match(raw: Dict[str, Any]) -> Dict[str, Any]:
    league = raw.get("league") or {}
    radiant = raw.get("radiantTeam") or {}
    dire = raw.get("direTeam") or {}
    series = raw.get("series") or {}
    series_type = (series.get("type") or "BO1").lower()
    # Stratz 用 BO1/BO3/BO5 大写，转 bo1/bo3/bo5 以与 OpenDota 一致
    if series_type and not series_type.startswith("bo"):
        series_type = "bo" + series_type[2:] if len(series_type) > 2 else "bo1"
    return {
        "match_id": raw.get("id"),
        "start_time": _parse_start_time(raw.get("startDateTime")),
        "duration": raw.get("durationSeconds"),
        "league_id": league.get("id"),
        "league_name": league.get("name"),
        "series_type": series_type,
        "radiant_team_id": radiant.get("id"),
        "dire_team_id": dire.get("id"),
        "radiant_name": radiant.get("name"),
        "dire_name": dire.get("name"),
        "radiant_score": raw.get("radiantScore") or 0,
        "dire_score": raw.get("direScore") or 0,
        "radiant_win": bool(raw.get("didRadiantWin", False)),
        "source": SOURCE_NAME,
    }


def _norm_team(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "team_id": raw.get("id"),
        "name": raw.get("name"),
        "tag": raw.get("tag"),
        "logo_url": raw.get("logo"),
        "source": SOURCE_NAME,
    }


# --------------------------- 客户端 --------------------------- #
class StratzClient:
    """Stratz GraphQL 异步客户端。"""

    name = SOURCE_NAME

    def __init__(
        self,
        api_key: Optional[str] = None,
        url: str = STRATZ_URL,
        rate_limit: float = STRATZ_RATE_LIMIT_SECONDS,
    ):
        self.api_key = api_key or STRATZ_API_KEY or os.getenv("STRATZ_API_KEY")
        if not self.api_key:
            raise ValueError(
                "StratzClient 需要 API key。请设置环境变量 STRATZ_API_KEY，"
                "或在 https://stratz.com/api 注册免费 key。"
            )
        self.url = url
        self.rate_limit = rate_limit
        self._last_request = 0.0
        # httpx.AsyncClient 懒初始化，避免 3.9 + uvloop 跨线程构造失败
        self._client: Optional[httpx.AsyncClient] = None

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=30.0,
                headers={
                    "User-Agent": "dota2elo/0.1",
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
        return self._client

    async def __aenter__(self) -> "StratzClient":
        self._ensure_client()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def _throttle(self) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        wait = self.rate_limit - (now - self._last_request)
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_request = loop.time()

    async def _gql(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        client = self._ensure_client()
        await self._throttle()
        payload = {"query": query, "variables": variables or {}}
        for attempt in range(3):
            try:
                resp = await client.post(self.url, json=payload)
                if resp.status_code in (429, 500, 502, 503, 504):
                    logger.warning("Stratz %s -> %s, retry %s", self.url, resp.status_code, attempt + 1)
                    await asyncio.sleep(2 ** attempt)
                    continue
                resp.raise_for_status()
                body = resp.json()
                if "errors" in body and body["errors"]:
                    logger.warning("Stratz GraphQL errors: %s", body["errors"][:2])
                    # 鉴权失败别重试
                    msg = str(body["errors"][0]).lower()
                    if "auth" in msg or "forbidden" in msg or "unauthorized" in msg:
                        return None
                return body.get("data")
            except httpx.HTTPError as e:
                logger.warning("Stratz HTTP error %s, attempt %s", e, attempt + 1)
                await asyncio.sleep(2 ** attempt)
        return None

    # ----- Pro Matches -----
    async def iter_pro_matches(self, max_pages: int = 50, page_size: int = 100) -> List[Dict[str, Any]]:
        """分页拉取职业比赛（规范化后）。"""
        all_matches: List[Dict[str, Any]] = []
        skip = 0
        for _ in range(max_pages):
            data = await self._gql(QUERY_PRO_MATCHES, {"take": page_size, "skip": skip})
            page = (data or {}).get("matches") or []
            if not page:
                break
            all_matches.extend([_norm_pro_match(m) for m in page if m.get("id")])
            if len(page) < page_size:
                break
            skip += page_size
        return all_matches

    # ----- Match Detail -----
    async def fetch_match(self, match_id: int) -> Optional[Dict[str, Any]]:
        data = await self._gql(QUERY_MATCH, {"id": match_id})
        match = (data or {}).get("match")
        if not match:
            return None
        return _norm_pro_match(match)

    # ----- Team -----
    async def fetch_team(self, team_id: int) -> Optional[Dict[str, Any]]:
        data = await self._gql(QUERY_TEAM, {"id": team_id})
        team = (data or {}).get("team")
        if not team:
            return None
        return _norm_team(team)
