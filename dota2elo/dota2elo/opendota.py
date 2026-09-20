"""OpenDota API 客户端。

OpenDota 公共 API（无需 token）:
- GET /proMatches                       职业比赛列表（支持 less_than_match_id 翻页）
- GET /matches/{match_id}               比赛详情
- GET /teams                            战队列表
- GET /teams/{team_id}                  战队详情
- GET /teams/{team_id}/matches          战队比赛历史

礼貌限速：1 req/s。所有方法已内置节流。
所有方法返回「规范化」shape（见 sources/__init__.py）。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

import httpx

from .config import (
    OPENDOTA_BASE,
    OPENDOTA_RATE_LIMIT_SECONDS,
    PRO_MATCHES_PAGE_SIZE,
)
from .sources import MatchSource

logger = logging.getLogger(__name__)

SOURCE_NAME = "opendota"


# --------------------------- 规范化辅助 --------------------------- #
def _norm_pro_match(raw: Dict[str, Any]) -> Dict[str, Any]:
    """OpenDota /proMatches 元素 -> 规范化 dict。"""
    return {
        "match_id": raw.get("match_id"),
        "start_time": raw.get("start_time"),
        "duration": raw.get("duration"),
        "league_id": raw.get("leagueid"),
        "league_name": raw.get("league_name"),
        "series_type": raw.get("series_type") or "bo1",
        "radiant_team_id": raw.get("radiant_team_id") or raw.get("team_id_radiant"),
        "dire_team_id": raw.get("dire_team_id") or raw.get("team_id_dire"),
        "radiant_name": raw.get("radiant_name") or raw.get("radiant_team_name"),
        "dire_name": raw.get("dire_name") or raw.get("dire_team_name"),
        "radiant_score": raw.get("radiant_score") or 0,
        "dire_score": raw.get("dire_score") or 0,
        "radiant_win": bool(raw.get("radiant_win", False)),
        "source": SOURCE_NAME,
    }


def _norm_match_detail(raw: Dict[str, Any]) -> Dict[str, Any]:
    """OpenDota /matches/{id} -> 规范化 dict（字段同 proMatches + players）。"""
    radiant = raw.get("radiant_team") or {}
    dire = raw.get("dire_team") or {}
    league = raw.get("league") or {}
    # players[]：每个选手的完整表现数据（v1.3 用于 4 维评分）
    players_norm = []
    for p in raw.get("players") or []:
        players_norm.append({
            "account_id": p.get("account_id"),
            "name": p.get("name") or p.get("personaname") or "",
            "team_id": (p.get("team_id") or
                        (radiant.get("team_id") if p.get("isRadiant") else dire.get("team_id"))),
            "hero_id": p.get("hero_id") or 0,
            "kills": p.get("kills") or 0,
            "deaths": p.get("deaths") or 0,
            "assists": p.get("assists") or 0,
            "gpm": p.get("gold_per_min") or 0,
            "xpm": p.get("xp_per_min") or 0,
            "net_worth": p.get("net_worth") or 0,
            "last_hits": p.get("last_hits") or 0,
            "denies": p.get("denies") or 0,
            "hero_damage": p.get("hero_damage") or 0,
            "tower_damage": p.get("tower_damage") or 0,
            "is_radiant": bool(p.get("isRadiant", False)),
            "won": bool(p.get("win", 0)),
        })
    return {
        "match_id": raw.get("match_id"),
        "start_time": raw.get("start_time"),
        "duration": raw.get("duration"),
        "league_id": league.get("leagueid"),
        "league_name": league.get("name"),
        "series_type": (raw.get("series_type") or "bo1"),
        "radiant_team_id": radiant.get("team_id"),
        "dire_team_id": dire.get("team_id"),
        "radiant_name": radiant.get("name"),
        "dire_name": dire.get("name"),
        "radiant_score": raw.get("radiant_score") or 0,
        "dire_score": raw.get("dire_score") or 0,
        "radiant_win": bool(raw.get("radiant_win", False)),
        "patch": raw.get("patch"),
        "players": players_norm,
        "source": SOURCE_NAME,
    }


def _norm_team(raw: Dict[str, Any]) -> Dict[str, Any]:
    """OpenDota /teams/{id} -> 规范化 dict。"""
    return {
        "team_id": raw.get("team_id"),
        "name": raw.get("name"),
        "tag": raw.get("tag"),
        "logo_url": raw.get("logo_url"),
        "source": SOURCE_NAME,
    }


# --------------------------- 客户端 --------------------------- #
class OpenDotaClient:
    """OpenDota 异步 HTTP 客户端。"""

    name = SOURCE_NAME

    def __init__(self, base_url: str = OPENDOTA_BASE, rate_limit: float = OPENDOTA_RATE_LIMIT_SECONDS):
        self.base_url = base_url.rstrip("/")
        self.rate_limit = rate_limit
        self._last_request = 0.0
        # httpx.AsyncClient 在 Python 3.9 + uvloop 下构造需要 event loop，
        # 改为懒初始化（在第一个 async 调用时建）
        self._client: Optional[httpx.AsyncClient] = None

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=30.0, headers={"User-Agent": "dota2elo/0.1"}
            )
        return self._client

    async def __aenter__(self) -> "OpenDotaClient":
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

    async def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        client = self._ensure_client()
        await self._throttle()
        url = f"{self.base_url}{path}"
        for attempt in range(3):
            try:
                resp = await client.get(url, params=params or {})
                if resp.status_code == 429 or resp.status_code >= 500:
                    logger.warning("OpenDota %s -> %s, retry %s", url, resp.status_code, attempt + 1)
                    await asyncio.sleep(2 ** attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except httpx.HTTPError as e:
                logger.warning("HTTP error %s on %s: %s", e, url, attempt + 1)
                await asyncio.sleep(2 ** attempt)
        logger.error("Giving up on %s after retries", url)
        return None

    # ----- Pro Matches -----
    async def fetch_pro_matches(self, less_than_match_id: Optional[int] = None) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {}
        if less_than_match_id is not None:
            params["less_than_match_id"] = less_than_match_id
        data = await self._get("/proMatches", params=params)
        return data or []

    async def iter_pro_matches(self, max_pages: int = 50) -> List[Dict[str, Any]]:
        """分页拉取职业比赛，返回**已规范化**的 dict 列表。"""
        all_matches: List[Dict[str, Any]] = []
        less_than: Optional[int] = None
        for _ in range(max_pages):
            page = await self.fetch_pro_matches(less_than_match_id=less_than)
            if not page:
                break
            all_matches.extend([_norm_pro_match(m) for m in page])
            less_than = min(m["match_id"] for m in page if m.get("match_id"))
            if len(page) < PRO_MATCHES_PAGE_SIZE:
                break
        return all_matches

    # ----- Match Detail -----
    async def fetch_match(self, match_id: int) -> Optional[Dict[str, Any]]:
        raw = await self._get(f"/matches/{match_id}")
        if not raw:
            return None
        return _norm_match_detail(raw)

    # ----- Teams -----
    async def fetch_team(self, team_id: int) -> Optional[Dict[str, Any]]:
        raw = await self._get(f"/teams/{team_id}")
        if not raw:
            return None
        return _norm_team(raw)
