from __future__ import annotations

import os
import time
from typing import Any

from tm.clients.proxy import proxies_for

API_BASE = (os.environ.get("SOFA_API_BASE") or "https://www.sofascore.com/api/v1").rstrip("/")
_IMPERSONATE = os.environ.get("SOFA_CURL_IMPERSONATE", "chrome131")
_MIN_INTERVAL = float(os.environ.get("SOFA_MIN_INTERVAL", "0.5"))
_REQUEST_TIMEOUT = int(os.environ.get("SOFA_REQUEST_TIMEOUT_SEC", "90"))
_REQUEST_RETRIES = max(1, int(os.environ.get("SOFA_REQUEST_RETRIES", "3")))
_RETRY_BACKOFF = float(os.environ.get("SOFA_REQUEST_RETRY_BACKOFF_SEC", "3.0"))

_API_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.sofascore.com/tennis",
    "Origin": "https://www.sofascore.com",
    "Cache-Control": "no-cache",
}


def _is_retryable(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(x in msg for x in ("timeout", "403", "429", "connection", "curl: (28)", "curl: (7)"))


def _event_score(ev: dict) -> str | None:
    hs = ev.get("homeScore") or {}
    as_ = ev.get("awayScore") or {}
    if not isinstance(hs, dict) or not isinstance(as_, dict):
        return None
    parts = []
    for key in ("period1", "period2", "period3", "period4", "period5"):
        if hs.get(key) is not None and as_.get(key) is not None:
            parts.append(f"{hs[key]}-{as_[key]}")
    if parts:
        return " ".join(parts)
    if hs.get("current") is not None and as_.get("current") is not None:
        return f"{hs['current']}-{as_['current']}"
    return None


class SofascoreClient:
    """Sofascore client via curl_cffi (Chrome TLS) + optional IPWO proxy."""

    def __init__(self, *, skip_warm: bool = False) -> None:
        try:
            from curl_cffi import requests as curl_requests
        except ImportError as exc:
            raise RuntimeError("缺少 curl_cffi，请 pip install curl_cffi") from exc

        self._curl = curl_requests
        proxies = proxies_for("Sofascore")
        self.session = curl_requests.Session(impersonate=_IMPERSONATE)
        if proxies:
            self.session.proxies.update(proxies)
            safe = (proxies.get("https") or proxies.get("http") or "").split("@")[-1]
            print(f"[sofascore] curl_cffi/{_IMPERSONATE} proxy {safe}")
        else:
            print(f"[sofascore] curl_cffi/{_IMPERSONATE} direct (proxy off)")
        self._last_request_at = 0.0
        self._skip_warm = skip_warm
        self._warmed = bool(skip_warm)
        self._stats = {"total": 0, "warmup": 0, "api": 0, "retries": 0}

    def get_request_stats(self) -> dict[str, int]:
        return dict(self._stats)

    def _count_request(self, kind: str, *, retry: bool = False) -> None:
        self._stats["total"] += 1
        if kind in self._stats:
            self._stats[kind] += 1
        if retry:
            self._stats["retries"] += 1

    def __enter__(self) -> "SofascoreClient":
        return self

    def __exit__(self, *args: Any) -> None:
        try:
            self.session.close()
        except Exception:
            pass

    def _throttle(self) -> None:
        wait = _MIN_INTERVAL - (time.time() - self._last_request_at)
        if wait > 0:
            time.sleep(wait)

    def warm_up(self) -> None:
        if self._warmed or self._skip_warm:
            self._warmed = True
            return
        for page in ("https://www.sofascore.com/", "https://www.sofascore.com/tennis"):
            try:
                self._throttle()
                r = self.session.get(page, timeout=25, headers={"Accept": "text/html,application/xhtml+xml"})
                self._last_request_at = time.time()
                self._count_request("warmup")
                if r.status_code >= 400:
                    print(f"[sofascore] warm_up {page} HTTP {r.status_code}")
            except Exception as exc:
                print(f"[sofascore] warm_up skip: {exc}")
        self._warmed = True

    def _get(self, url: str, *, headers: dict | None = None) -> Any:
        last_exc: Exception | None = None
        for attempt in range(_REQUEST_RETRIES):
            try:
                self._throttle()
                self._last_request_at = time.time()
                self._count_request("api", retry=attempt > 0)
                return self.session.get(url, timeout=_REQUEST_TIMEOUT, headers=headers)
            except Exception as exc:
                last_exc = exc
                if attempt + 1 >= _REQUEST_RETRIES or not _is_retryable(exc):
                    detail = str(exc).strip() or repr(exc)
                    raise RuntimeError(f"Sofascore 请求失败: {detail} | url={url}") from exc
                self._warmed = False
                self.warm_up()
                time.sleep(_RETRY_BACKOFF * (attempt + 1))
        detail = str(last_exc).strip() if last_exc else "request failed"
        raise RuntimeError(f"Sofascore 请求失败: {detail or repr(last_exc)} | url={url}") from last_exc

    def _api_get(self, path: str, *, referer: str | None = None) -> dict[str, Any]:
        if not self._warmed:
            self.warm_up()
        ref = referer or "https://www.sofascore.com/tennis"
        url = f"{API_BASE}/{path.lstrip('/')}"
        headers = {**_API_HEADERS, "Referer": ref}
        resp = self._get(url, headers=headers)
        if resp.status_code == 403:
            self._warmed = False
            self.warm_up()
            resp = self._get(url, headers=headers)
        if resp.status_code >= 400:
            snippet = (resp.text or "")[:120].replace("\n", " ")
            raise RuntimeError(f"Sofascore HTTP {resp.status_code}: {path} {snippet}")
        return resp.json()

    def get_live_tennis_events(self) -> dict[str, Any]:
        return self._api_get("sport/tennis/events/live")

    def get_scheduled_tennis_events(self, day: str) -> dict[str, Any]:
        return self._api_get(f"sport/tennis/scheduled-events/{day}")
