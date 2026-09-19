"""Polymarket: Gamma events (tennis/NBA/Dota) + moneyline prices (CLOB book mid)."""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import datetime
from typing import Any

import requests

from tm.clients.proxy import proxies_for

GAMMA = (os.environ.get("POLY_GAMMA_BASE") or "https://gamma-api.polymarket.com").rstrip("/")
CLOB = (os.environ.get("POLY_CLOB_BASE") or "https://clob.polymarket.com").rstrip("/")
TENNIS_TAG_ID = int(os.environ.get("POLY_TENNIS_TAG_ID", "864"))
NBA_TAG_ID = int(os.environ.get("POLY_NBA_TAG_ID", "745"))
# 若 Polymarket 有专用 Dota tag id，设 POLY_DOTA_TAG_ID；否则用 tag_slug（默认 dota-2）
_DOTA_TAG_RAW = (os.environ.get("POLY_DOTA_TAG_ID") or "").strip()
DOTA_TAG_ID = int(_DOTA_TAG_RAW) if _DOTA_TAG_RAW.isdigit() else None
DOTA_TAG_SLUG = (os.environ.get("POLY_DOTA_TAG_SLUG") or "dota-2").strip() or "dota-2"
CACHE_MS = int(os.environ.get("POLY_TENNIS_CACHE_MS", "120000"))
MAX_OFFSET = int(os.environ.get("POLY_TENNIS_MAX_OFFSET", "500"))
MAX_DATE_DRIFT_MS = 4 * 24 * 60 * 60 * 1000
_TIMEOUT = int(os.environ.get("POLY_REQUEST_TIMEOUT_SEC", "15"))

_poly_caches: dict[str, dict[str, Any]] = {}
_request_count = 0


def get_request_count() -> int:
    return _request_count


def _poly_http_get(base: str, path: str, *, params: dict[str, Any] | None = None, label: str = "poly") -> Any:
    global _request_count
    _request_count += 1
    url = f"{base}/{path.lstrip('/')}"
    # 管理员可关代理：COLLECT_*_USE_PROXY；Polymarket 开代理时也可无凭证直连
    proxies = proxies_for("Polymarket")
    resp = requests.get(
        url,
        params=params,
        headers={"Accept": "application/json", "User-Agent": "yuce-bid/1.0"},
        timeout=_TIMEOUT,
        proxies=proxies,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"{label} HTTP {resp.status_code}: {path}")
    return resp.json()


def _gamma_get(path: str, *, params: dict[str, Any] | None = None) -> Any:
    return _poly_http_get(GAMMA, path, params=params, label="gamma")


def _clob_get(path: str, *, params: dict[str, Any] | None = None) -> Any:
    return _poly_http_get(CLOB, path, params=params, label="clob")


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


def parse_token_ids(mkt: dict[str, Any] | None) -> list[str]:
    if not mkt:
        return []
    tokens = _parse_json_field(mkt.get("clobTokenIds"), [])
    if not isinstance(tokens, list):
        return []
    return [str(t) for t in tokens if t]


def book_mid_price(token_id: str) -> float | None:
    """Best-bid/ask mid from CLOB order book; closer to tradable depth than Gamma outcomePrices."""
    if not token_id:
        return None
    try:
        book = _clob_get("book", params={"token_id": token_id})
    except Exception as exc:
        print(f"[polymarket] clob book skip {token_id[:12]}…: {exc}")
        return None
    if not isinstance(book, dict):
        return None
    bids = book.get("bids") or []
    asks = book.get("asks") or []
    try:
        best_bid = max((float(b["price"]) for b in bids), default=0.0) if bids else 0.0
        best_ask = min((float(a["price"]) for a in asks), default=0.0) if asks else 0.0
    except (TypeError, ValueError, KeyError):
        return None
    if best_bid > 0 and best_ask > 0:
        return (best_bid + best_ask) / 2.0
    if best_bid > 0:
        return best_bid
    if best_ask > 0:
        return best_ask
    return None


def parse_prices_from_clob(mkt: dict[str, Any] | None) -> list[float] | None:
    tokens = parse_token_ids(mkt)
    if len(tokens) < 2:
        return None
    a = book_mid_price(tokens[0])
    b = book_mid_price(tokens[1])
    if a is None or b is None:
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


def fetch_polymarket_events_by_tag(
    tag_id: int | None = None,
    *,
    tag_slug: str | None = None,
    cache_key: str | None = None,
    max_offset: int | None = None,
    raise_on_total_failure: bool = False,
    include_closed: bool = True,
) -> list[dict[str, Any]]:
    """按 Gamma tag_id 或 tag_slug 分页拉取 active 事件；默认 closed=false/true 两趟。"""
    if tag_id is None and not tag_slug:
        raise ValueError("tag_id or tag_slug required")
    key = cache_key or (f"tag:{tag_id}" if tag_id is not None else f"slug:{tag_slug}")
    if not include_closed:
        key = f"{key}:open"
    now = time.time() * 1000
    bucket = _poly_caches.get(key) or {}
    cached = bucket.get("items") or []
    if cached and now - float(bucket.get("at") or 0) < CACHE_MS:
        return list(cached)

    by_slug: dict[str, dict[str, Any]] = {}
    page_size = 100
    offset_cap = MAX_OFFSET if max_offset is None else int(max_offset)
    pages_ok = 0
    last_err: Exception | None = None
    label = f"tag_id={tag_id}" if tag_id is not None else f"tag_slug={tag_slug}"
    closed_passes = ("false", "true") if include_closed else ("false",)
    for closed in closed_passes:
        offset = 0
        while offset <= offset_cap:
            try:
                params: dict[str, Any] = {
                    "active": "true",
                    "closed": closed,
                    "limit": page_size,
                    "offset": offset,
                }
                if tag_id is not None:
                    params["tag_id"] = tag_id
                else:
                    params["tag_slug"] = tag_slug
                rows = _gamma_get("events", params=params)
                if not isinstance(rows, list):
                    break
                pages_ok += 1
                for ev in rows:
                    if ev.get("slug"):
                        by_slug[str(ev["slug"])] = ev
                if len(rows) < page_size:
                    break
                offset += page_size
            except Exception as exc:
                last_err = exc
                print(f"[polymarket] gamma page skip {label}: {exc}")
                break

    if not by_slug and pages_ok == 0 and last_err is not None:
        msg = f"gamma fetch {label} failed: {last_err}"
        if raise_on_total_failure:
            raise RuntimeError(msg) from last_err
        print(f"[polymarket] {msg}")

    items = [slim_gamma_event(ev) for ev in by_slug.values()]
    if not include_closed:
        items = [x for x in items if not x.get("closed")]
    _poly_caches[key] = {"at": now, "items": items}
    return items


def fetch_polymarket_tennis_events() -> list[dict[str, Any]]:
    return fetch_polymarket_events_by_tag(TENNIS_TAG_ID, cache_key="tennis")


def is_sport_match_event(item: dict[str, Any]) -> bool:
    """只要对阵赛事（A vs B），排除 Yes/No 舆情、自由市场、冠军盘等命题。"""
    side_a = str(item.get("sideA") or "").strip()
    side_b = str(item.get("sideB") or "").strip()
    if not side_a or not side_b:
        return False
    if re.match(r"^(yes|no)$", side_a, re.I) or re.match(r"^(yes|no)$", side_b, re.I):
        return False
    title = str(item.get("title") or "")
    slug = str(item.get("slug") or "")
    blob = f"{title} {slug}"
    if not re.search(r"\bvs\.?\b", blob, re.I):
        return False
    low_slug = slug.lower()
    low_title = title.lower()
    # 同场附加盘 / 舆情命题
    if "more-markets" in low_slug or "more markets" in low_title:
        return False
    if any(x in low_slug or x in low_title for x in ("free-agency", "free agency", "next-team", "next team")):
        return False
    if low_title.startswith("will ") or low_slug.startswith("will-"):
        return False
    if "champion" in low_slug and "vs" not in low_slug:
        return False
    return True


def _prices_of(item: dict[str, Any]) -> tuple[float, float] | None:
    prices = item.get("prices")
    if not isinstance(prices, (list, tuple)) or len(prices) < 2:
        return None
    try:
        return float(prices[0]), float(prices[1])
    except (TypeError, ValueError):
        return None


def is_open_priced_match(item: dict[str, Any], *, eps: float = 0.005) -> bool:
    """未关闭，且双方价格都不在 0%/100%（排除已实质落定盘）。"""
    if item.get("closed"):
        return False
    pair = _prices_of(item)
    if pair is None:
        return False
    a, b = pair
    if a <= eps or a >= 1.0 - eps or b <= eps or b >= 1.0 - eps:
        return False
    return True


def fetch_polymarket_nba_events(*, raise_on_total_failure: bool = True) -> list[dict[str, Any]]:
    """未结束且双方未到 100% 的 NBA 对阵。"""
    items = fetch_polymarket_events_by_tag(
        NBA_TAG_ID,
        cache_key="nba",
        raise_on_total_failure=raise_on_total_failure,
        include_closed=False,
    )
    return [x for x in items if is_sport_match_event(x) and is_open_priced_match(x)]


def fetch_polymarket_dota_events(*, raise_on_total_failure: bool = True) -> list[dict[str, Any]]:
    """未结束且双方未到 100% 的 Dota 对阵。"""
    if DOTA_TAG_ID is not None:
        items = fetch_polymarket_events_by_tag(
            DOTA_TAG_ID,
            cache_key="dota",
            raise_on_total_failure=raise_on_total_failure,
            include_closed=False,
        )
    else:
        items = fetch_polymarket_events_by_tag(
            tag_slug=DOTA_TAG_SLUG,
            cache_key="dota",
            raise_on_total_failure=raise_on_total_failure,
            include_closed=False,
        )
    return [x for x in items if is_sport_match_event(x) and is_open_priced_match(x)]


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
    source = "clob"
    prices = parse_prices_from_clob(mkt)
    if not prices:
        source = "gamma"
        prices = parse_prices(mkt)
    if not prices:
        return poly
    outcomes = parse_outcomes((mkt or {}).get("outcomes")) or (poly.get("moneyline") or {}).get("outcomes") or []
    next_poly = dict(poly)
    next_poly["active"] = bool(ev.get("active")) if ev.get("active") is not None else poly.get("active")
    next_poly["closed"] = bool(ev.get("closed")) if ev.get("closed") is not None else poly.get("closed")
    next_poly["live"] = bool(ev.get("live")) if ev.get("live") is not None else poly.get("live")
    next_poly["ended"] = bool(ev.get("ended")) if ev.get("ended") is not None else poly.get("ended")
    if ev.get("score") is not None:
        next_poly["score"] = ev.get("score")
    if ev.get("period") is not None:
        next_poly["period"] = ev.get("period")
    next_poly["home_price"] = prices[0]
    next_poly["away_price"] = prices[1]
    next_poly["priceSource"] = source
    next_poly["moneyline"] = {
        **(poly.get("moneyline") or {}),
        "question": (mkt or {}).get("question") or (poly.get("moneyline") or {}).get("question"),
        "slug": (mkt or {}).get("slug") or (poly.get("moneyline") or {}).get("slug") or poly.get("slug"),
        "outcomes": outcomes if len(outcomes) >= 2 else (poly.get("moneyline") or {}).get("outcomes"),
        "prices": prices,
        "source": source,
    }
    return next_poly


def sport_state_from_gamma(ev: dict[str, Any] | None) -> dict[str, Any]:
    """从 Gamma event 抽取体育状态（比分/是否完赛）。"""
    if not isinstance(ev, dict):
        return {}
    status_raw = ev.get("gameStatus") or ev.get("status")
    if isinstance(status_raw, dict):
        status = status_raw.get("type") or status_raw.get("description") or ""
    else:
        status = status_raw or ""
    return {
        "score": ev.get("score"),
        "period": ev.get("period"),
        "elapsed": ev.get("elapsed"),
        "live": bool(ev.get("live")) if ev.get("live") is not None else None,
        "ended": bool(ev.get("ended")) if ev.get("ended") is not None else None,
        "closed": bool(ev.get("closed")) if ev.get("closed") is not None else None,
        "active": ev.get("active"),
        "finishedTimestamp": ev.get("finishedTimestamp"),
        "status": str(status or "").strip(),
    }


def _status_type_from_sport(state: dict[str, Any]) -> str | None:
    if state.get("ended") is True or state.get("closed") is True:
        return "finished"
    st = str(state.get("status") or "").lower().replace(" ", "")
    if st in {"finished", "final", "f/ot", "ended", "cancelled", "canceled", "retired", "walkover", "forfeit"}:
        return "finished"
    if st in {"inprogress", "in_progress", "live", "running", "suspended", "break"}:
        return "inprogress"
    if st in {"scheduled", "notstarted", "not_started", "postponed", "delayed"}:
        return "notstarted"
    if state.get("live") is True:
        return "inprogress"
    if state.get("live") is False and state.get("ended") is False:
        return "notstarted"
    return None


def _apply_parsed_score(match: dict[str, Any], score: str) -> None:
    """解析 Polymarket score 字符串（如 6-4 / 6-4, 3-6, 1-0）写入 homeScore/awayScore。"""
    raw = str(score or "").strip()
    if not raw:
        return
    parts = [p.strip() for p in re.split(r"[,|/]+", raw) if p.strip()]
    if len(parts) == 1:
        parts = [p for p in re.split(r"\s+", parts[0]) if p]
    pairs: list[tuple[int, int]] = []
    for p in parts:
        m = re.match(r"^(\d+)\s*[-:]\s*(\d+)$", p)
        if m:
            pairs.append((int(m.group(1)), int(m.group(2))))
    if not pairs:
        return
    home_score: dict[str, Any] = {}
    away_score: dict[str, Any] = {}
    if len(pairs) == 1:
        h, a = pairs[0]
        home_score["current"] = h
        home_score["display"] = h
        away_score["current"] = a
        away_score["display"] = a
    else:
        hs = as_ = 0
        for i, (h, a) in enumerate(pairs[:5], 1):
            home_score[f"period{i}"] = h
            away_score[f"period{i}"] = a
            if h > a:
                hs += 1
            elif a > h:
                as_ += 1
        home_score["current"] = hs
        home_score["display"] = hs
        away_score["current"] = as_
        away_score["display"] = as_
    match["homeScore"] = home_score
    match["awayScore"] = away_score
    match["home_score"] = home_score.get("current")
    match["away_score"] = away_score.get("current")


def _winner_from_poly_prices(poly: dict[str, Any] | None) -> str | None:
    if not isinstance(poly, dict):
        return None
    try:
        hp = float(poly.get("home_price"))
        ap = float(poly.get("away_price"))
    except (TypeError, ValueError):
        ml = (poly.get("moneyline") or {}).get("prices") or []
        if len(ml) < 2:
            return None
        try:
            hp, ap = float(ml[0]), float(ml[1])
        except (TypeError, ValueError):
            return None
    if hp >= 0.9 and ap <= 0.1:
        return "home"
    if ap >= 0.9 and hp <= 0.1:
        return "away"
    return None


def apply_sport_state_to_match(
    match: dict[str, Any],
    ev: dict[str, Any],
    *,
    poly: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """用 Gamma 体育字段刷新比赛比分/状态；完赛时尽量用赔率推断胜方。"""
    state = sport_state_from_gamma(ev)
    score = state.get("score")
    if score is not None and str(score).strip() != "":
        match["scoreText"] = str(score)
        match["score"] = str(score)
        _apply_parsed_score(match, str(score))
    period = state.get("period")
    if period:
        match["period"] = period
        match["statusDescription"] = str(period)

    st = _status_type_from_sport(state)
    if st:
        match["statusType"] = st
        if st == "finished":
            match["status"] = "Finished"
        elif st == "inprogress":
            match["status"] = str(period or "In Progress")
        elif st == "notstarted":
            match["status"] = "Not started"

    if st == "finished" or state.get("ended") is True or state.get("closed") is True:
        winner = _winner_from_poly_prices(poly)
        if winner:
            match["winner"] = winner
            match["winnerCode"] = 1 if winner == "home" else 2

    return {
        "score": score,
        "statusType": match.get("statusType"),
        "ended": state.get("ended"),
        "live": state.get("live"),
        "closed": state.get("closed"),
    }


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
