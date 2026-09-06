#!/usr/bin/env python3
"""Quick IPWO proxy check (run on server)."""
from __future__ import annotations

import os
import sys

import requests

from ipwo_proxy import ipwo_proxy_urls, ipwo_username
from monitor_env import load_monitor_env

load_monitor_env()

BASE = os.environ.get("IPWO_PROXY_USER", "ss1029")
PASS = os.environ.get("IPWO_PROXY_PASS", "123456789x")
HOST = os.environ.get("IPWO_PROXY_HOST", "us.ipwo.net")
PORT = os.environ.get("IPWO_PROXY_PORT", "7878")

CANDIDATES = [
    BASE,
    f"{BASE}_custom_zone_US",
    f"{BASE}_custom_zone_us",
    f"{BASE}_zone_US",
    f"{BASE}_zone_us",
    ipwo_username(BASE, zone="US"),
    ipwo_username(BASE, zone="US", session="123456", sticky_min=10),
]


def try_user(user: str) -> tuple[int, str]:
    proxies = ipwo_proxy_urls(username=user, password=PASS)
    if not proxies:
        return 0, "no proxy"
    try:
        r = requests.get("http://ipinfo.io/json", proxies=proxies, timeout=25)
        return r.status_code, r.text[:160]
    except Exception as exc:
        return -1, str(exc)[:160]


def main() -> int:
    print(f"host={HOST}:{PORT} pass_len={len(PASS)}")
    ok = False
    for user in CANDIDATES:
        code, body = try_user(user)
        mark = "OK" if code == 200 and '"ip"' in body else "FAIL"
        print(f"[{mark}] user={user} code={code} body={body}")
        if mark == "OK":
            ok = True
            break
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
