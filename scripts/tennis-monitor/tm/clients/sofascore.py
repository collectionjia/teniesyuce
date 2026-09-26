"""SofaScore 客户端：底层统一走移动端 API（api.sofascore.com）。

SofascoreClient 保留旧调用签名（warm_up / referer / skip_warm），供采集器与 Node worker 复用。
"""
from __future__ import annotations

from typing import Any

from tm.clients.proxy import proxies_for
from tm.clients.sofascore_mobile import SofascoreMobileClient


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


class SofascoreClient(SofascoreMobileClient):
    """采集器用：强制代理 + 兼容旧接口；实际请求走 mobile API（api.sofascore.com）。"""

    def __init__(self, *, skip_warm: bool = False) -> None:
        super().__init__()
        proxies = proxies_for("Sofascore")
        if proxies:
            self.session.proxies.clear()
            self.session.proxies.update(proxies)
            safe = (proxies.get("https") or proxies.get("http") or "").split("@")[-1]
            print(f"[sofascore] mobile-api proxy {safe}", flush=True)
        else:
            print("[sofascore] mobile-api direct", flush=True)

    def warm_up(self) -> None:
        return

    def _api_get(self, path: str, *, referer: str | None = None) -> dict[str, Any]:
        return super()._api_get(path)

    def get_live_tennis_events(self) -> dict[str, Any]:
        return self._api_get("sport/tennis/events/live")

    def get_event(self, event_id: int | str) -> dict[str, Any]:
        return self._api_get(f"event/{event_id}")

    def get_scheduled_tennis_events(self, day: str) -> dict[str, Any]:
        return self._api_get(f"sport/tennis/scheduled-events/{day}")
