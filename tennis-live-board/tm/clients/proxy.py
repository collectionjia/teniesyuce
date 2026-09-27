#!/usr/bin/env python3
"""Build IPWO / SOFA_HTTP_PROXY for Sofascore collect (https://docs.ipwo.net/)."""
from __future__ import annotations

import os
from urllib.parse import quote


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip().strip("\r")


def ipwo_username(
    base: str | None = None,
    *,
    zone: str | None = None,
    session: str | None = None,
    sticky_min: int | None = None,
) -> str:
    user = (base or _env("IPWO_PROXY_USER") or _env("IPWO_USERNAME")).strip()
    if not user:
        return ""
    zone = (zone if zone is not None else _env("IPWO_PROXY_ZONE")).strip()
    if zone and "_custom_zone_" not in user and "_zone_" not in user:
        user = f"{user}_custom_zone_{zone.upper()}"
    sess = (session if session is not None else _env("IPWO_PROXY_SESSION")).strip()
    if sess and "_sid_" not in user:
        user = f"{user}_sid_{sess}"
    mins = sticky_min if sticky_min is not None else _env("IPWO_PROXY_STICKY_MIN")
    if mins and "_time_" not in user:
        user = f"{user}_time_{int(mins)}"
    return user


def ipwo_proxy_urls(*, username: str | None = None, password: str | None = None) -> dict[str, str]:
    host = (_env("IPWO_PROXY_HOST") or "us.ipwo.net").strip()
    port = (_env("IPWO_PROXY_PORT") or "7878").strip()
    user = username or ipwo_username()
    passwd = (password or _env("IPWO_PROXY_PASS") or _env("IPWO_PASSWORD")).strip()
    if not user or not passwd:
        return {}
    auth = f"{quote(user, safe='')}:{quote(passwd, safe='')}"
    base = f"http://{auth}@{host}:{port}"
    return {"http": base, "https": base}


def sofa_proxy_map() -> dict[str, str]:
    """优先 IPWO；无 IPWO 时用 SOFA_HTTP_PROXY / HTTP_PROXY。"""
    ipwo = ipwo_proxy_urls()
    if ipwo:
        return ipwo
    direct = (_env("SOFA_HTTP_PROXY") or _env("HTTP_PROXY")).strip()
    if direct:
        https = (_env("SOFA_HTTPS_PROXY") or _env("HTTPS_PROXY") or direct).strip()
        return {"http": direct, "https": https}
    return {}


def _flag_on(name: str) -> bool:
    return _env(name).lower() in {"1", "true", "yes", "on"}


def proxy_job() -> str:
    job = (_env("COLLECT_PROXY_JOB") or "top100").strip().lower()
    return "inplay" if job in {"inplay", "inplay_tick", "refresh"} else "top100"


def use_proxy_for_job(job: str | None = None) -> bool:
    """Top100：有代理配置则走；盘中仅 COLLECT_INPLAY_USE_PROXY=1。"""
    j = (job or proxy_job()).strip().lower()
    if j in {"inplay", "inplay_tick", "refresh"}:
        return _flag_on("COLLECT_INPLAY_USE_PROXY")
    return bool(sofa_proxy_map())


def optional_proxy() -> dict[str, str]:
    return sofa_proxy_map()


def proxies_for(scope: str = "Sofascore", *, job: str | None = None) -> dict[str, str] | None:
    scope_l = str(scope).lower()
    if scope_l == "polymarket":
        if not use_proxy_for_job(job):
            return None
        return optional_proxy() or None
    if not use_proxy_for_job(job):
        return None
    return sofa_proxy_map() or None


def require_proxy(scope: str = "Sofascore") -> dict[str, str]:
    proxies = sofa_proxy_map()
    if not proxies:
        raise RuntimeError(
            f"{scope} 需要 IPWO 或 SOFA_HTTP_PROXY。"
            "请在 monitor.env 配置 IPWO_PROXY_HOST/PORT/USER/PASS（见 env.monitor.example）。"
        )
    return proxies


def proxy_status_public() -> dict[str, str | bool]:
    direct = (_env("SOFA_HTTP_PROXY") or _env("HTTP_PROXY")).strip()
    if use_proxy_for_job() and direct:
        host = direct.split("@")[-1] if "@" in direct else direct
        return {"enabled": True, "mode": "env", "host": host, "zone": ""}
    host = (_env("IPWO_PROXY_HOST") or "us.ipwo.net").strip()
    port = (_env("IPWO_PROXY_PORT") or "7878").strip()
    user = ipwo_username()
    passwd = (_env("IPWO_PROXY_PASS") or _env("IPWO_PASSWORD")).strip()
    zone = (_env("IPWO_PROXY_ZONE") or "").strip()
    if use_proxy_for_job() and user and passwd:
        return {
            "enabled": True,
            "mode": "ipwo",
            "host": f"{host}:{port}",
            "zone": zone.upper() if zone else "",
        }
    return {
        "enabled": False,
        "mode": "direct",
        "host": "",
        "zone": "",
        "note": "直连（未配置 IPWO / SOFA_HTTP_PROXY）",
    }
