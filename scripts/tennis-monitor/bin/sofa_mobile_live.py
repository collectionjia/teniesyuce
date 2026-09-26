#!/usr/bin/env python3
"""SofaScore mobile API: token/init + live tennis (from APK reverse)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

# allow `python bin/sofa_mobile_live.py` from scripts/tennis-monitor
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tm.clients.proxy import optional_proxy  # noqa: E402

API_BASE = (os.environ.get("SOFA_MOBILE_API_BASE") or "https://api.sofascore.com/api/v1").rstrip("/")
IMPERSONATE = os.environ.get("SOFA_CURL_IMPERSONATE", "chrome131")
APP_VERSION = int(os.environ.get("SOFA_APP_VERSION", "250000"))
USER_AGENT = os.environ.get("SOFA_MOBILE_UA", f"SofaScore/{APP_VERSION} Android/14")
UUID_FILE = Path(os.environ.get("SOFA_DEVICE_UUID_FILE") or (_ROOT / ".sofa_device_uuid"))


def _session():
    try:
        from curl_cffi import requests as curl_requests
    except ImportError as exc:
        raise SystemExit(
            "缺少 curl_cffi。在 scripts/tennis-monitor 执行:\n"
            "  python -m venv venv && venv/Scripts/python -m pip install -r requirements.txt"
        ) from exc

    s = curl_requests.Session(impersonate=IMPERSONATE)
    proxies = optional_proxy()
    if proxies:
        s.proxies.update(proxies)
    return s


def device_uuid() -> str:
    if UUID_FILE.exists():
        val = UUID_FILE.read_text(encoding="utf-8").strip()
        if val:
            return val
    val = str(uuid.uuid4())
    UUID_FILE.write_text(val, encoding="utf-8")
    return val


def token_init(session, *, device_uuid_value: str | None = None) -> str:
    uid = device_uuid_value or device_uuid()
    body = {"deviceType": "android", "uuid": uid, "version": APP_VERSION}
    r = session.post(
        f"{API_BASE}/token/init",
        json=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"token/init HTTP {r.status_code}: {(r.text or '')[:200]}")
    data = r.json()
    token = data.get("token")
    if not token:
        raise RuntimeError(f"token/init 无 token 字段: {data}")
    return str(token)


def api_get(session, token: str, path: str) -> dict[str, Any]:
    url = f"{API_BASE}/{path.lstrip('/')}"
    r = session.get(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": USER_AGENT,
        },
        timeout=45,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"GET {path} HTTP {r.status_code}: {(r.text or '')[:200]}")
    return r.json()


def slim_live_event(ev: dict[str, Any]) -> dict[str, Any]:
    home = ev.get("homeTeam") or {}
    away = ev.get("awayTeam") or {}
    status = ev.get("status") if isinstance(ev.get("status"), dict) else {}
    hs = ev.get("homeScore") or {}
    as_ = ev.get("awayScore") or {}
    return {
        "id": ev.get("id"),
        "status": status.get("description") or ev.get("status"),
        "statusType": status.get("type"),
        "home": home.get("name") or home.get("shortName"),
        "away": away.get("name") or away.get("shortName"),
        "homeScore": hs.get("current") if isinstance(hs, dict) else hs,
        "awayScore": as_.get("current") if isinstance(as_, dict) else as_,
        "tournament": (ev.get("tournament") or {}).get("name"),
        "slug": ev.get("slug"),
    }


def main() -> None:
    p = argparse.ArgumentParser(description="SofaScore mobile API: token/init + live tennis")
    p.add_argument("--live", action="store_true", help="拉 live 网球（默认）")
    p.add_argument("--event", type=int, help="单场 ID，附带 incidents / point-by-point")
    p.add_argument("--raw", action="store_true", help="输出完整 JSON")
    p.add_argument("--uuid", help="覆盖 device uuid（默认持久化到 .sofa_device_uuid）")
    args = p.parse_args()

    if not args.live and not args.event:
        args.live = True

    session = _session()
    token = token_init(session, device_uuid_value=args.uuid)
    out: dict[str, Any] = {"deviceUuid": args.uuid or device_uuid(), "tokenPrefix": token[:24] + "..."}

    if args.live:
        data = api_get(session, token, "sport/tennis/events/live")
        if args.raw:
            out["live"] = data
        else:
            events = data.get("events") or []
            out["liveCount"] = len(events)
            out["events"] = [slim_live_event(ev) for ev in events]

    if args.event:
        eid = args.event
        out["event"] = api_get(session, token, f"event/{eid}")
        try:
            out["incidents"] = api_get(session, token, f"event/{eid}/incidents")
        except RuntimeError as exc:
            out["incidentsError"] = str(exc)
        try:
            out["pointByPoint"] = api_get(session, token, f"event/{eid}/point-by-point")
        except RuntimeError as exc:
            out["pointByPointError"] = str(exc)

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
