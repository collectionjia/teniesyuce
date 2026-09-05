"""Polymarket Gamma client: NBA game markets only (moneyline team vs team)."""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

GAMMA = os.environ.get("POLY_GAMMA_URL", "https://gamma-api.polymarket.com").rstrip("/")
# Polymarket sports catalog: NBA series
NBA_SERIES_ID = os.environ.get("POLY_SERIES_ID", "10345")
UA = {"Accept": "application/json", "User-Agent": "yuce-bid-poly-scraper/1.0"}

# 单场比赛标题：Lakers vs. Warriors / Knicks @ Spurs
_GAME_TITLE = re.compile(
    r"^\s*(?P<a>.+?)\s+(?:vs\.?|@)\s+(?P<b>.+?)\s*$",
    re.IGNORECASE,
)
_PROP_TITLE = re.compile(
    r"(which team|field goal|points|spread|over|under|first |last |"
    r"to score|player|quarter|half|exact|prop|ou\b|moneyline prop)",
    re.IGNORECASE,
)


def _parse_json_field(v: Any, fallback: Any) -> Any:
    if v is None:
        return fallback
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return fallback
    return v


def _pick_moneyline(markets: list[dict] | None) -> dict | None:
    for m in markets or []:
        outs = [str(x) for x in _parse_json_field(m.get("outcomes"), [])]
        if len(outs) >= 2 and outs[0].lower() not in ("yes", "no"):
            return m
    return None


def _parse_prices(mkt: dict | None) -> list[float] | None:
    if not mkt:
        return None
    prices = _parse_json_field(mkt.get("outcomePrices"), None)
    if not isinstance(prices, list) or len(prices) < 2:
        prices = _parse_json_field(mkt.get("prices"), None)
    if not isinstance(prices, list) or len(prices) < 2:
        return None
    try:
        a, b = float(prices[0]), float(prices[1])
    except (TypeError, ValueError):
        return None
    if not (a == a and b == b):
        return None
    return [a, b]


def _cents(prices: list[float] | None) -> list[int] | None:
    if not prices or len(prices) < 2:
        return None
    raw = [round(p * 100) for p in prices]
    if len(raw) == 2 and abs(raw[0] + raw[1] - 100) <= 2:
        raw[1] = 100 - raw[0]
    return raw


def is_nba_game_event(ev: dict) -> bool:
    """只保留 NBA 单场胜负盘，排除选秀/冠军/交易/球员道具等。"""
    title = str(ev.get("title") or "").strip()
    slug = str(ev.get("slug") or "").lower()
    if not title or not _GAME_TITLE.match(title):
        return False
    if _PROP_TITLE.search(title):
        return False
    if ":" in title:
        return False
    # slug 常见 nba-lal-gsw-2026-01-15；排除 draft/champion/playoffs futures
    if re.search(r"(draft|champion|playoff|mvp|roy|free-agency|retire|trade)", slug):
        return False
    mkt = _pick_moneyline(ev.get("markets") or [])
    if not mkt:
        return False
    outs = [str(x) for x in _parse_json_field(mkt.get("outcomes"), [])]
    if len(outs) < 2 or outs[0].lower() in ("yes", "no"):
        return False
    return True


def normalize_event(ev: dict) -> dict | None:
    slug = (ev.get("slug") or "").strip()
    if not slug:
        return None
    mkt = _pick_moneyline(ev.get("markets") or [])
    prices = _parse_prices(mkt)
    outcomes = [str(x) for x in _parse_json_field((mkt or {}).get("outcomes"), [])]
    if len(outcomes) < 2:
        outcomes = []
    volume = ev.get("volume") or ev.get("volumeNum") or (mkt or {}).get("volume") or 0
    try:
        volume = float(volume)
    except (TypeError, ValueError):
        volume = 0.0
    return {
        "id": ev.get("id") or slug,
        "slug": slug,
        "title": ev.get("title") or "",
        "url": f"https://polymarket.com/event/{slug}",
        "startDate": ev.get("startDate") or None,
        "endDate": ev.get("endDate") or None,
        "closed": bool(ev.get("closed")),
        "active": bool(ev.get("active")) if ev.get("active") is not None else True,
        "outcomes": outcomes,
        "prices": prices,
        "cents": _cents(prices),
        "volume": volume,
        "question": (mkt or {}).get("question") or ev.get("title") or "",
    }


async def fetch_events_by_tag(tag_slug: str = "nba", timeout: float = 20.0) -> list[dict]:
    """兼容旧接口名：实际按 NBA series 拉比赛盘。"""
    return await fetch_nba_games(timeout=timeout)


async def fetch_nba_games(timeout: float = 20.0) -> list[dict]:
    """从 NBA series 拉取单场比赛（含近期已结束，赛季空窗时不至于列表为空）。"""
    sid = NBA_SERIES_ID
    urls = [
        f"{GAMMA}/events?series_id={sid}&closed=false&order=startDate&ascending=true&limit=100",
        f"{GAMMA}/events?series_id={sid}&active=true&closed=false&limit=100",
        f"{GAMMA}/events?series_id={sid}&order=startDate&ascending=false&limit=100",
        f"{GAMMA}/events?series_id={sid}&order=endDate&ascending=false&limit=100",
    ]
    by_slug: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=timeout, headers=UA, follow_redirects=True) as client:
        for url in urls:
            try:
                res = await client.get(url)
                if res.status_code != 200:
                    logger.warning("gamma %s -> HTTP %s", url, res.status_code)
                    continue
                body = res.json()
                if not isinstance(body, list):
                    continue
                for ev in body:
                    if not isinstance(ev, dict):
                        continue
                    if not is_nba_game_event(ev):
                        continue
                    slug = (ev.get("slug") or "").strip()
                    if slug:
                        by_slug[slug] = ev
            except Exception as exc:
                logger.warning("gamma fetch failed %s: %s", url, exc)

    out: list[dict] = []
    for ev in by_slug.values():
        item = normalize_event(ev)
        if item:
            out.append(item)

    # 未完赛优先，再按开赛时间
    def sort_key(x: dict):
        return (1 if x.get("closed") else 0, x.get("endDate") or x.get("startDate") or "", x.get("title") or "")

    out.sort(key=sort_key)
    return out


def load_cache(path: Path) -> dict:
    if not path.exists():
        return {"updatedAt": None, "tag": None, "events": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"updatedAt": None, "tag": None, "events": []}


def save_cache(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
