#!/usr/bin/env python3
"""Collect HTTP proxy helpers — SOFA_HTTP_PROXY / COLLECT_*_USE_PROXY."""
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


def _flag_on(name: str) -> bool:
    return _env(name).lower() in {"1", "true", "yes", "on"}


def use_proxy_for_job(job: str | None = None) -> bool:
    """Top100：有 SOFA_HTTP_PROXY 就走代理；盘中仅当 COLLECT_INPLAY_USE_PROXY=1。

    注意：勿用 COLLECT_TOP100_USE_PROXY=0 盖掉后加载的 monitor.env URL
    （server spawn 时若一时解析不到 URL 会先写 0）。
    """
    j = (job or proxy_job()).strip().lower()
    if j in {"inplay", "inplay_tick", "refresh"}:
        return _flag_on("COLLECT_INPLAY_USE_PROXY")
    return bool(sofa_proxy_map())


def optional_proxy() -> dict[str, str]:
    return sofa_proxy_map()


def proxies_for(scope: str = "Sofascore", *, job: str | None = None) -> dict[str, str] | None:
    """Top100 有代理 URL 时返回 proxies；盘中须显式 COLLECT_INPLAY_USE_PROXY=1。"""
    if not use_proxy_for_job(job):
        return None
    return sofa_proxy_map() or None


def require_proxy(scope: str = "Sofascore") -> dict[str, str]:
    """Compat: 有代理则返回，否则空（直连）。"""
    return sofa_proxy_map() if use_proxy_for_job() else {}


def proxy_status_public() -> dict[str, str | bool]:
    direct = (_env("SOFA_HTTP_PROXY") or _env("HTTP_PROXY")).strip()
    if use_proxy_for_job() and direct:
        host = direct.split("@")[-1] if "@" in direct else direct
        return {"enabled": True, "mode": "env", "host": host, "zone": ""}
    return {
        "enabled": False,
        "mode": "direct",
        "host": "",
        "zone": "",
        "note": "直连（无代理）",
    }
