from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from . import polymarket

logger = logging.getLogger(__name__)

TAG_SLUG = os.environ.get("POLY_TAG_SLUG", "dota-2")
_DEFAULT_CACHE = Path(__file__).resolve().parents[1] / "data" / "cache.json"
CACHE_PATH = Path(os.environ.get("CACHE_PATH") or str(_DEFAULT_CACHE))
SPORT_LABEL = os.environ.get("SPORT_LABEL", "DOTA2")
REFRESH_SEC = int(os.environ.get("REFRESH_SEC", "60"))

app = FastAPI(title=f"{SPORT_LABEL} Polymarket")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_state: dict = {"updatedAt": None, "tag": TAG_SLUG, "events": [], "error": None}


async def refresh() -> dict:
    events = await polymarket.fetch_events_by_tag(TAG_SLUG)
    payload = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "tag": TAG_SLUG,
        "events": events,
        "count": len(events),
        "error": None,
    }
    polymarket.save_cache(CACHE_PATH, payload)
    _state.clear()
    _state.update(payload)
    return payload


def bootstrap_from_disk() -> None:
    cached = polymarket.load_cache(CACHE_PATH)
    if cached.get("events"):
        _state.clear()
        _state.update(cached)
        _state.setdefault("tag", TAG_SLUG)
        _state.setdefault("error", None)


async def _loop():
    bootstrap_from_disk()
    while True:
        try:
            payload = await refresh()
            logger.info("refreshed %s events=%s", TAG_SLUG, payload.get("count"))
        except Exception as exc:
            logger.warning("refresh failed: %s", exc)
            _state["error"] = str(exc)
        await asyncio.sleep(max(15, REFRESH_SEC))


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(_loop())


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "sport": SPORT_LABEL,
        "tag": TAG_SLUG,
        "count": len(_state.get("events") or []),
        "updatedAt": _state.get("updatedAt"),
    }


@app.get("/api/events")
def list_events(q: str = Query("", description="search title/outcomes")):
    events = list(_state.get("events") or [])
    needle = (q or "").strip().lower()
    if needle:
        events = [
            e
            for e in events
            if needle in (e.get("title") or "").lower()
            or any(needle in str(o).lower() for o in (e.get("outcomes") or []))
        ]
    return {
        "ok": True,
        "sport": SPORT_LABEL,
        "tag": TAG_SLUG,
        "updatedAt": _state.get("updatedAt"),
        "count": len(events),
        "events": events,
    }


@app.post("/api/refresh")
async def force_refresh():
    try:
        payload = await refresh()
        return {"ok": True, **{k: payload[k] for k in ("updatedAt", "tag", "count")}}
    except Exception as exc:
        _state["error"] = str(exc)
        return {"ok": False, "error": str(exc)}
