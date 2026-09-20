"""多源交叉校验：并行拉两个源，报告差异。

诊断用，不修改数据库。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from ..sources import MatchSource

logger = logging.getLogger(__name__)


def _diff_dict(a: Dict[str, Any], b: Dict[str, Any], ignore_keys: set) -> List[Dict[str, Any]]:
    """返回两个 dict 字段级别差异列表。"""
    diffs: List[Dict[str, Any]] = []
    keys = set(a.keys()) | set(b.keys())
    for k in sorted(keys):
        if k in ignore_keys:
            continue
        va, vb = a.get(k), b.get(k)
        if va != vb:
            diffs.append({"field": k, "a": va, "b": vb})
    return diffs


async def cross_check(
    source_a: MatchSource,
    source_b: MatchSource,
    max_pages: int = 1,
    sample_team_ids: Optional[List[int]] = None,
) -> Dict[str, Any]:
    """对比两个源的输出。

    对比维度：
    1) iter_pro_matches (1 页 = 100 场)：match_id 集合、字段差异
    2) sample teams：取前 N 个 match 涉及的 team_id，比对 fetch_team 字段

    返回报告 dict（JSON 可序列化）。
    """
    matches_a, matches_b = await asyncio.gather(
        source_a.iter_pro_matches(max_pages=max_pages),
        source_b.iter_pro_matches(max_pages=max_pages),
    )

    a_by_id = {m.get("match_id"): m for m in matches_a if m.get("match_id")}
    b_by_id = {m.get("match_id"): m for m in matches_b if m.get("match_id")}
    common = set(a_by_id) & set(b_by_id)
    only_a = set(a_by_id) - set(b_by_id)
    only_b = set(b_by_id) - set(a_by_id)

    # 字段差异（忽略 source 字段本身）
    field_diffs: List[Dict[str, Any]] = []
    for mid in list(common)[:50]:  # 最多抽样 50 场
        diffs = _diff_dict(a_by_id[mid], b_by_id[mid], ignore_keys={"source"})
        if diffs:
            field_diffs.append({"match_id": mid, "diffs": diffs})

    # 团队抽样
    if sample_team_ids is None:
        # 默认取前 10 场涉及的 team
        sample_team_ids = []
        for m in list(matches_a)[:10]:
            for tid in (m.get("radiant_team_id"), m.get("dire_team_id")):
                if tid and tid not in sample_team_ids:
                    sample_team_ids.append(tid)
            if len(sample_team_ids) >= 10:
                break

    team_diffs: List[Dict[str, Any]] = []
    for tid in sample_team_ids:
        ta, tb = await asyncio.gather(
            source_a.fetch_team(tid),
            source_b.fetch_team(tid),
        )
        if ta is None and tb is None:
            continue
        if ta is None or tb is None:
            team_diffs.append({
                "team_id": tid,
                "a": ta, "b": tb,
                "kind": "missing",
            })
            continue
        diffs = _diff_dict(ta, tb, ignore_keys={"source"})
        if diffs:
            team_diffs.append({"team_id": tid, "diffs": diffs, "a_name": ta.get("name"), "b_name": tb.get("name")})

    return {
        "summary": {
            "source_a": source_a.name,
            "source_b": source_b.name,
            "matches_a": len(matches_a),
            "matches_b": len(matches_b),
            "common": len(common),
            "only_in_a": len(only_a),
            "only_in_b": len(only_b),
            "field_diff_matches": len(field_diffs),
            "team_diffs": len(team_diffs),
        },
        "missing_in_b": sorted(only_a)[:20],
        "missing_in_a": sorted(only_b)[:20],
        "match_field_diffs": field_diffs[:20],
        "team_diffs": team_diffs,
    }
