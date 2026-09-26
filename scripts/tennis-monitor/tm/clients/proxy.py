#!/usr/bin/env python3
"""Build IPWO proxy config per https://docs.ipwo.net/"""
from __future__ import annotations

import os
from urllib.parse import quote


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip().strip("\r")


def ipwo_username(base: str | None = None, *, zone: str | None = None, session: str | None = None, sticky_min: int | None = None) -> str:
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
    port_raw = (_env("IPWO_PROXY_PORT") or "7878").strip()
    try:
        port_n = int(port_raw)
    except ValueError:
        port_n = -1
    if not (0 < port_n <= 65535):
        # 坏端口（如 78781）直接当未配置，避免 curl (5)
        return {}
    port = str(port_n)
    user = username or ipwo_username()
    passwd = (password or _env("IPWO_PROXY_PASS") or _env("IPWO_PASSWORD")).strip()
    if not user or not passwd:
        return {}
    auth = f"{quote(user, safe='')}:{quote(passwd, safe='')}"
    base = f"http://{auth}@{host}:{port}"
    return {"http": base, "https": base}


def sofa_proxy_map() -> dict[str, str]:
    direct = (_env("SOFA_HTTP_PROXY") or _env("HTTP_PROXY")).strip()
    if direct:
        https = (_env("SOFA_HTTPS_PROXY") or _env("HTTPS_PROXY") or direct).strip()
        return {"http": direct, "https": https}
    return ipwo_proxy_urls()


def _env_flag(name: str, default: bool = True) -> bool:
    raw = (_env(name) or "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def proxy_job() -> str:
    """当前采集任务：top100 | inplay（由 Node spawn 注入 COLLECT_PROXY_JOB）。"""
    job = (_env("COLLECT_PROXY_JOB") or "top100").strip().lower()
    return "inplay" if job in {"inplay", "inplay_tick", "refresh"} else "top100"


def use_proxy_for_job(job: str | None = None) -> bool:
    """Sofascore 采集统一直连（mobile API）；开关保留兼容，默认关。"""
    j = (job or proxy_job()).strip().lower()
    if j in {"inplay", "inplay_tick", "refresh"}:
        return _env_flag("COLLECT_INPLAY_USE_PROXY", False)
    return _env_flag("COLLECT_TOP100_USE_PROXY", False)


def optional_proxy() -> dict[str, str]:
    """有代理则用；无代理返回空 dict（允许直连）。"""
    return sofa_proxy_map()


def proxies_for(scope: str = "Sofascore", *, job: str | None = None) -> dict[str, str] | None:
    """Sofascore / 其它：按 COLLECT_*_USE_PROXY；关则直连。Polymarket 有代理才用。"""
    scope_l = str(scope).lower()
    if scope_l == "polymarket":
        return optional_proxy() or None
    if not use_proxy_for_job(job):
        return None
    return require_proxy(scope)


def require_proxy(scope: str = "Sofascore") -> dict[str, str]:
    """禁止直连：未配置任何代理（IPWO 或 SOFA_HTTP_PROXY）时直接报错，不落地直连采集。"""
    proxies = sofa_proxy_map()
    if not proxies:
        raise RuntimeError(
            f"{scope} 采集必须经 IPWO 代理，禁止直连采集。"
            "请在 monitor.env 配置 IPWO_PROXY_HOST/IPWO_PROXY_PORT/IPWO_PROXY_USER/IPWO_PROXY_PASS"
            "（参考 env.monitor.example，勿提交 Git）后重试。"
        )
    return proxies


def proxy_status_public() -> dict[str, str | bool]:
    """Safe proxy summary for admin status (no credentials)."""
    direct = (_env("SOFA_HTTP_PROXY") or _env("HTTP_PROXY")).strip()
    if direct:
        host = direct.split("@")[-1] if "@" in direct else direct
        return {"enabled": True, "mode": "env", "host": host, "zone": ""}
    host = (_env("IPWO_PROXY_HOST") or "us.ipwo.net").strip()
    port = (_env("IPWO_PROXY_PORT") or "7878").strip()
    user = ipwo_username()
    passwd = (_env("IPWO_PROXY_PASS") or _env("IPWO_PASSWORD")).strip()
    zone = (_env("IPWO_PROXY_ZONE") or "").strip()
    if user and passwd:
        return {
            "enabled": True,
            "mode": "ipwo",
            "host": f"{host}:{port}",
            "zone": zone.upper() if zone else "",
        }
    return {
        "enabled": False,
        "mode": "no_proxy",
        "host": "",
        "zone": "",
        "note": "未配置 IPWO 代理，禁止直连采集",
    }
