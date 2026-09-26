#!/usr/bin/env python3
"""Collect HTTP proxy helpers — Sofascore/Polymarket go direct (no IPWO)."""
from __future__ import annotations

import os


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip().strip("\r")


def sofa_proxy_map() -> dict[str, str]:
    """Optional generic env proxy only (SOFA_HTTP_PROXY / HTTP_PROXY). No IPWO."""
    direct = (_env("SOFA_HTTP_PROXY") or _env("HTTP_PROXY")).strip()
    if not direct:
        return {}
    https = (_env("SOFA_HTTPS_PROXY") or _env("HTTPS_PROXY") or direct).strip()
    return {"http": direct, "https": https}


def proxy_job() -> str:
    job = (_env("COLLECT_PROXY_JOB") or "top100").strip().lower()
    return "inplay" if job in {"inplay", "inplay_tick", "refresh"} else "top100"


def use_proxy_for_job(job: str | None = None) -> bool:
    """Always False — Sofascore mobile API + Polymarket are direct."""
    return False


def optional_proxy() -> dict[str, str]:
    return sofa_proxy_map()


def proxies_for(scope: str = "Sofascore", *, job: str | None = None) -> dict[str, str] | None:
    """Always direct unless generic SOFA_HTTP_PROXY/HTTP_PROXY is set and job flag on."""
    if not use_proxy_for_job(job):
        return None
    return sofa_proxy_map() or None


def require_proxy(scope: str = "Sofascore") -> dict[str, str]:
    """Compat: never required; return empty (direct)."""
    return {}


def proxy_status_public() -> dict[str, str | bool]:
    direct = (_env("SOFA_HTTP_PROXY") or _env("HTTP_PROXY")).strip()
    if direct:
        host = direct.split("@")[-1] if "@" in direct else direct
        return {"enabled": True, "mode": "env", "host": host, "zone": ""}
    return {
        "enabled": False,
        "mode": "direct",
        "host": "",
        "zone": "",
        "note": "直连（无代理）",
    }
