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
    port = (_env("IPWO_PROXY_PORT") or "7878").strip()
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
