"""数据源抽象层。

所有数据源（OpenDota、Stratz 等）都实现 `MatchSource` 协议，
返回统一的「规范化」字典（canonical shape），上层 `ingest.py`
不关心数据来自哪个源。

规范化字段（与原 OpenDota 字段保持一致以兼容现有 upsert 逻辑）：
- match_id: int
- start_time: int | None   # unix 秒
- duration: int | None      # 秒
- league_id: int | None
- league_name: str | None
- series_type: str | None   # bo1 / bo3 / bo5
- radiant_team_id: int | None
- dire_team_id: int | None
- radiant_name: str | None
- dire_name: str | None
- radiant_score: int | None
- dire_score: int | None
- radiant_win: bool
- source: str               # "opendota" | "stratz"  (诊断用)
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


@runtime_checkable
class MatchSource(Protocol):
    """统一的数据源接口。"""

    name: str

    async def iter_pro_matches(self, max_pages: int = 50) -> List[Dict[str, Any]]:
        """分页拉取职业比赛。"""

    async def fetch_match(self, match_id: int) -> Optional[Dict[str, Any]]:
        """单场比赛详情。"""

    async def fetch_team(self, team_id: int) -> Optional[Dict[str, Any]]:
        """战队元数据。"""

    async def aclose(self) -> None:
        """关闭底层 HTTP 客户端。"""
