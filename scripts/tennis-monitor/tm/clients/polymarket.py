"""Polymarket Gamma API: tennis event match + moneyline prices."""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import datetime
from typing import Any

import requests

from tm.clients.proxy import require_proxy

GAMMA = (os.environ.get("POLY_GAMMA_BASE") or "https://gamma-api.polymarket.com").rstrip("/")
TENNIS_TAG_ID = int(os.environ.get("POLY_TENNIS_TAG_ID", "864"))
CACHE_MS = int(os.environ.get("POLY_TENNIS_CACHE_MS", "120000"))
MAX_OFFSET = int(os.environ.get("POLY_TENNIS_MAX_OFFSET", "500"))
MAX_DATE_DRIFT_MS = 4 * 24 * 60 * 60 * 1000
_TIMEOUT = int(os.environ.get("POLY_REQUEST_TIMEOUT_SEC", "15"))

_poly_cache: dict[str, Any] = {"at": 0.0, "items": []}
_request_count = 0


def get_request_count() -> int:
    return _request_count


def _gamma_get(path: str, *, params: dict[str, Any] | None = None) -> Any:
    global _request_count
    _request_count += 1
    url = f"{GAMMA}/{path.lstrip('/')}"
    proxies = require_proxy("Polymarket")
    resp = requests.get(
        url,
        params=params,
        headers={"Accept": "application/json", "User-Agent": "yuce-bid/1.0"},
        timeout=_TIMEOUT,
        proxies=proxies,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"gamma HTTP {resp.status_code}: {path}")
    return resp.json()


def normalize_name(name: str | None) -> str:
    s = unicodedata.normalize("NFKD", str(name or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def tokens_of(name: str | None) -> list[str]:
    n = normalize_name(name)
    return [t for t in n.split() if len(t) >= 2] if n else []


def names_match(a: str | None, b: str | None) -> bool:
    na = normalize_name(a)
    nb = normalize_name(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if len(na) >= 4 and len(nb) >= 4 and (na in nb or nb in na):
        return True
    ta = tokens_of(a)
    tb = tokens_of(b)
    if not ta or not tb:
        return False
    set_b = set(tb)
    overlap = [t for t in ta if t in set_b]
    if overlap and len(overlap) >= min(len(ta), len(tb)):
        return True
    if overlap and min(len(ta), len(tb)) == 1:
        return True
    return False


def _parse_json_field(raw: Any, fallback: Any) -> Any:
    if raw is None:
        return fallback
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return fallback
    return raw


def parse_outcomes(raw: Any) -> list[str]:
    parsed = _parse_json_field(raw, [])
    if isinstance(parsed, list):
        return [str(x) for x in parsed]
    return []


def parse_prices(mkt: dict[str, Any] | None) -> list[float] | None:
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
    if a != a or b != b:
        return None
    return [a, b]


def pick_moneyline_market(markets: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    for mkt in markets or []:
        outs = parse_outcomes(mkt.get("outcomes"))
        if len(outs) >= 2 and not re.match(r"^(yes|no)$", outs[0], re.I):
            return mkt
    return (markets or [None])[0]


def extract_event_sides(ev: dict[str, Any]) -> tuple[str | None, str | None]:
    title = str(ev.get("title") or "")
    chunks: list[str] = []
    if ":" in title:
        chunks.append(title.split(":", 1)[-1].strip())
    chunks.append(title)
    for chunk in chunks:
        m = re.search(r"([\w][\w\s\.\-']*?)\s+vs\.?\s+([\w][\w\s\.\-']*?)(?:\s*\(|\s+-|$)", chunk, re.I)
        if m:
            return m.group(1).strip(), m.group(2).strip()
    m = re.search(r"will\s+(.+?)\s+beat\s+(.+?)\??$", title, re.I)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    mk = pick_moneyline_market(ev.get("markets") or [])
    outs = parse_outcomes((mk or {}).get("outcomes"))
    if len(outs) >= 2 and not re.search(r"\bvs\.?\b", outs[0], re.I):
        return outs[0], outs[1]
    return None, None


def _last_token(name: str | None) -> str:
    parts = re.sub(r"[^A-Za-z\s]", "", unicodedata.normalize("NFKD", str(name or "")))
    parts = "".join(c for c in parts if not unicodedata.combining(c)).strip().split()
    return re.sub(r"[^A-Za-z]", "", parts[-1]) if parts else ""


def _parse_iso_ms(raw: Any) -> float:
    if not raw:
        return float("nan")
    try:
        s = str(raw).replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp() * 1000
    except (TypeError, ValueError):
        return float("nan")


def slim_gamma_event(ev: dict[str, Any]) -> dict[str, Any]:
    side_a, side_b = extract_event_sides(ev)
    mk = pick_moneyline_market(ev.get("markets") or [])
    prices = parse_prices(mk)
    slug = str(ev.get("slug") or "")
    return {
        "slug": slug,
        "title": ev.get("title") or "",
        "url": f"https://polymarket.com/event/{slug}" if slug else "",
        "sideA": side_a,
        "sideB": side_b,
        "prices": prices,
        "closed": bool(ev.get("closed")),
        "active": ev.get("active"),
        "startMs": _parse_iso_ms(ev.get("startDate")),
        "endMs": _parse_iso_ms(ev.get("endDate")),
        "markets": ev.get("markets") or [],
    }


def fetch_polymarket_tennis_events() -> list[dict[str, Any]]:
    now = time.time() * 1000
    cached = _poly_cache.get("items") or []
    if cached and now - float(_poly_cache.get("at") or 0) < CACHE_MS:
        return list(cached)
    by_slug: dict[str, dict[str, Any]] = {}
    page_size = 100
    for closed in ("false", "true"):
        offset = 0
        while offset <= MAX_OFFSET:
            try:
                rows = _gamma_get(
                    "events",
                    params={
                        "tag_id": TENNIS_TAG_ID,
                        "active": "true",
                        "closed": closed,
                        "limit": page_size,
                        "offset": offset,
                    },
                )
                if not isinstance(rows, list):
                    break
                for ev in rows:
                    if ev.get("slug"):
                        by_slug[str(ev["slug"])] = ev
                if len(rows) < page_size:
                    break
                offset += page_size
            except Exception as exc:
                print(f"[polymarket] gamma page skip: {exc}")
                break
    items = [slim_gamma_event(ev) for ev in by_slug.values()]
    _poly_cache["at"] = now
    _poly_cache["items"] = items
    return items


def search_gamma_pair(home: str | None, away: str | None) -> list[dict[str, Any]]:
    q = f"{_last_token(home)} {_last_token(away)}".strip()
    if len(q) < 4:
        return []
    try:
        body = _gamma_get("public-search", params={"q": q})
        events = body.get("events") if isinstance(body, dict) else []
        return [slim_gamma_event(ev) for ev in events or []]
    except Exception as exc:
        print(f"[polymarket] search skip: {exc}")
        return []


def match_start_ms(match: dict[str, Any]) -> float:
    ts = match.get("startTimestamp")
    try:
        n = float(ts)
    except (TypeError, ValueError):
        return float("nan")
    if n > 1e12:
        return n
    if n > 1e9:
        return n * 1000
    return float("nan")


def match_sides(
    home: str | None,
    away: str | None,
    events: list[dict[str, Any]],
    match_start: float,
) -> dict[str, Any] | None:
    if not home or not away or not events:
        return None
    best: dict[str, Any] | None = None
    best_score = -1.0
    for ev in events:
        side_a, side_b = ev.get("sideA"), ev.get("sideB")
        if not side_a or not side_b:
            continue
        same = (names_match(home, side_a) and names_match(away, side_b)) or (
            names_match(home, side_b) and names_match(away, side_a)
        )
        if not same:
            continue
        score = 10.0
        start_ms = ev.get("startMs")
        if isinstance(start_ms, (int, float)) and start_ms == start_ms and isinstance(match_start, (int, float)) and match_start == match_start:
            drift = abs(start_ms - match_start)
            if drift > MAX_DATE_DRIFT_MS:
                continue
            score += max(0.0, 20.0 - drift / (6 * 60 * 60 * 1000))
        elif isinstance(start_ms, (int, float)) and start_ms == start_ms:
            score += 2.0
        if not ev.get("closed"):
            score += 3.0
        if score > best_score:
            best_score = score
            best = ev
    if not best or best_score < 10:
        return None
    return best


def fetch_event_by_slug(slug: str) -> dict[str, Any] | None:
    body = _gamma_get("events", params={"slug": slug})
    if isinstance(body, list):
        return body[0] if body else None
    return body if isinstance(body, dict) else None


def apply_live_prices(poly: dict[str, Any], ev: dict[str, Any]) -> dict[str, Any]:
    mkt = pick_moneyline_market(ev.get("markets") or [])
    prices = parse_prices(mkt)
    if not prices:
        return poly
    outcomes = parse_outcomes((mkt or {}).get("outcomes")) or (poly.get("moneyline") or {}).get("outcomes") or []
    next_poly = dict(poly)
    next_poly["active"] = bool(ev.get("active")) if ev.get("active") is not None else poly.get("active")
    next_poly["closed"] = bool(ev.get("closed")) if ev.get("closed") is not None else poly.get("closed")
    next_poly["home_price"] = prices[0]
    next_poly["away_price"] = prices[1]
    next_poly["moneyline"] = {
        **(poly.get("moneyline") or {}),
        "question": (mkt or {}).get("question") or (poly.get("moneyline") or {}).get("question"),
        "slug": (mkt or {}).get("slug") or (poly.get("moneyline") or {}).get("slug") or poly.get("slug"),
        "outcomes": outcomes if len(outcomes) >= 2 else (poly.get("moneyline") or {}).get("outcomes"),
        "prices": prices,
    }
    return next_poly


def _poly_from_hit(hit: dict[str, Any], home: str, away: str) -> dict[str, Any]:
    prices = hit.get("prices") or [0.5, 0.5]
    return {
        "title": hit.get("title") or f"{home} vs {away}",
        "url": hit.get("url") or "",
        "slug": hit.get("slug") or "",
        "home_price": prices[0],
        "away_price": prices[1],
        "moneyline": {
            "outcomes": [hit.get("sideA") or home, hit.get("sideB") or away],
            "prices": prices,
        },
    }


def format_polymarket_label(poly: dict[str, Any] | None) -> str | None:
    if not poly:
        return None
    ml = poly.get("moneyline") or {}
    prices = ml.get("prices")
    if not prices or len(prices) < 2:
        prices = [poly.get("home_price"), poly.get("away_price")]
    if not prices or prices[0] is None and prices[1] is None:
        return None
    return f"{prices[0] or '-'} / {prices[1] or '-'}"


def enrich_events_polymarket(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Match filtered Sofascore events to Polymarket; refresh moneyline prices."""
    poly_by_event: dict[str, Any] = {}
    if not events:
        return poly_by_event

    pool = fetch_polymarket_tennis_events()
    matched = 0
    for ev in events:
        eid = ev.get("id")
        if eid is None:
            continue
        home = ev.get("home") or (ev.get("homePlayer") or {}).get("name")
        away = ev.get("away") or (ev.get("awayPlayer") or {}).get("name")
        start_ms = match_start_ms(ev)
        hit = match_sides(home, away, pool, start_ms)
        if not hit:
            extra = search_gamma_pair(home, away)
            hit = match_sides(home, away, extra, start_ms)
        if not hit:
            continue
        poly = _poly_from_hit(hit, str(home or ""), str(away or ""))
        slug = poly.get("slug")
        if slug:
            try:
                detail = fetch_event_by_slug(str(slug))
                if detail:
                    poly = apply_live_prices(poly, detail)
            except Exception as exc:
                print(f"[polymarket] detail skip {slug}: {exc}")
        poly_by_event[str(eid)] = poly
        matched += 1

    print(f"[polymarket] linked {matched}/{len(events)} (gamma requests={get_request_count()})")
    return poly_by_event
