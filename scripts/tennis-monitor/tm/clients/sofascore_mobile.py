"""SofaScore 移动端 API 客户端（APK 逆向：token/init + Bearer）。

请求节奏按真人浏览：默认间隔 ~0.8s，遇 429 指数退避重试。
"""
from __future__ import annotations

import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

# 移动端 API 根地址（APK 内为 api.sofascore.com）
API_BASE = (os.environ.get("SOFA_MOBILE_API_BASE") or "https://api.sofascore.com/api/v1").rstrip("/")
# curl_cffi 模拟 Chrome TLS 指纹，避免直连被 403
IMPERSONATE = os.environ.get("SOFA_CURL_IMPERSONATE", "chrome131")
# APK 版本号，须为 int；对应 User-Agent 里的 SofaScore/250000
APP_VERSION = int(os.environ.get("SOFA_APP_VERSION", "250000"))
USER_AGENT = os.environ.get("SOFA_MOBILE_UA", f"SofaScore/{APP_VERSION} Android/14")
# 请求最小间隔（秒），模拟正常翻页节奏
MIN_INTERVAL = float(os.environ.get("SOFA_MOBILE_MIN_INTERVAL", "0.8"))
# 429/5xx 重试次数与退避基数
MAX_RETRIES = max(1, int(os.environ.get("SOFA_MOBILE_RETRIES", "4")))
RETRY_BACKOFF = float(os.environ.get("SOFA_MOBILE_RETRY_BACKOFF", "3.0"))


def _uuid_file_candidates() -> list[Path]:
    """包目录可能只读（容器/镜像）；依次试 env → 包目录 → /tmp。"""
    env = (os.environ.get("SOFA_DEVICE_UUID_FILE") or "").strip()
    if env:
        return [Path(env)]
    pkg = Path(__file__).resolve().parents[2] / ".sofa_device_uuid"
    tmp = Path(tempfile.gettempdir()) / "sofa_device_uuid"
    return [pkg, tmp]


class SofascoreMobileClient:
    """通过 token/init 获取 JWT，后续请求带 Authorization: Bearer。"""

    def __init__(self) -> None:
        try:
            from curl_cffi import requests as curl_requests
        except ImportError as exc:
            raise RuntimeError(
                f"缺少 curl_cffi（{exc}）。请在 scripts/tennis-monitor 执行 pip install -r requirements.txt"
            ) from exc

        self._curl = curl_requests
        self.session = curl_requests.Session(impersonate=IMPERSONATE)
        # 默认直连；SofascoreClient 可写入 session.proxies，请求时显式带上
        self._token: str | None = None  # 进程内缓存，首次 _api_get 时 lazy init
        self._device_uuid_cache: str | None = None
        self._last_request_at = 0.0
        self._stats = {"total": 0, "api": 0, "retries": 0}

    def _proxy_kwargs(self) -> dict[str, Any]:
        proxies = dict(getattr(self.session, "proxies", None) or {})
        return {"proxies": proxies} if proxies else {}

    def get_request_stats(self) -> dict[str, int]:
        return dict(self._stats)

    def __enter__(self) -> "SofascoreMobileClient":
        return self

    def __exit__(self, *args: Any) -> None:
        try:
            self.session.close()
        except Exception:
            pass

    def _throttle(self) -> None:
        wait = MIN_INTERVAL - (time.time() - self._last_request_at)
        if wait > 0:
            time.sleep(wait)

    def _device_uuid(self) -> str:
        """读取或生成设备 UUID；写盘失败（只读 FS）则落到 /tmp 或仅内存。"""
        if self._device_uuid_cache:
            return self._device_uuid_cache
        for path in _uuid_file_candidates():
            try:
                if path.is_file():
                    val = path.read_text(encoding="utf-8").strip()
                    if val:
                        self._device_uuid_cache = val
                        return val
            except OSError:
                continue
        val = str(uuid.uuid4())
        self._device_uuid_cache = val
        for path in _uuid_file_candidates():
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(val, encoding="utf-8")
                break
            except OSError:
                continue
        return val

    def _ensure_token(self, *, force: bool = False) -> str:
        """POST token/init；遇 429 退避重试，勿短时间多次 init。"""
        if self._token and not force:
            return self._token
        body = {"deviceType": "android", "uuid": self._device_uuid(), "version": APP_VERSION}
        last_err: Exception | None = None
        for attempt in range(MAX_RETRIES):
            self._throttle()
            try:
                r = self.session.post(
                    f"{API_BASE}/token/init",
                    json=body,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                    timeout=30,
                    **self._proxy_kwargs(),
                )
            except Exception as exc:
                last_err = exc
                self._stats["retries"] += 1
                time.sleep(RETRY_BACKOFF * (attempt + 1))
                continue
            finally:
                self._last_request_at = time.time()
            self._stats["total"] += 1
            self._stats["api"] += 1
            if r.status_code == 429 or r.status_code >= 500:
                self._stats["retries"] += 1
                last_err = RuntimeError(f"token/init HTTP {r.status_code}: {(r.text or '')[:200]}")
                time.sleep(RETRY_BACKOFF * (attempt + 1) * (2 if r.status_code == 429 else 1))
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"token/init HTTP {r.status_code}: {(r.text or '')[:200]}")
            token = (r.json() or {}).get("token")
            if not token:
                raise RuntimeError("token/init 无 token")
            self._token = str(token)
            return self._token
        raise RuntimeError(str(last_err) if last_err else "token/init failed")

    def _api_get(self, path: str) -> dict[str, Any]:
        """GET 相对路径，如 rankings/type/7、sport/tennis/events/live。"""
        url = f"{API_BASE}/{path.lstrip('/')}"
        last_err: Exception | None = None
        for attempt in range(MAX_RETRIES):
            token = self._ensure_token(force=False)
            self._throttle()
            try:
                r = self.session.get(
                    url,
                    headers={
                        "Accept": "application/json",
                        "Authorization": f"Bearer {token}",
                        "User-Agent": USER_AGENT,
                    },
                    timeout=45,
                    **self._proxy_kwargs(),
                )
            except Exception as exc:
                last_err = exc
                self._stats["retries"] += 1
                time.sleep(RETRY_BACKOFF * (attempt + 1))
                continue
            finally:
                self._last_request_at = time.time()
            self._stats["total"] += 1
            self._stats["api"] += 1
            if r.status_code == 401:
                # token 失效，强制重新 init 后再试
                self._token = None
                self._stats["retries"] += 1
                self._ensure_token(force=True)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                self._stats["retries"] += 1
                last_err = RuntimeError(
                    f"Sofascore HTTP {r.status_code}: {path} {(r.text or '')[:120]}"
                )
                # 429 多歇一会，像正常人被限流后等待
                time.sleep(RETRY_BACKOFF * (attempt + 1) * (2.5 if r.status_code == 429 else 1))
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"Sofascore HTTP {r.status_code}: {path} {(r.text or '')[:120]}")
            return r.json()
        raise RuntimeError(str(last_err) if last_err else f"Sofascore GET failed: {path}")

    def get_live_tennis_events(self) -> dict[str, Any]:
        """进行中网球赛事；其它接口可直接 client._api_get(path)。"""
        return self._api_get("sport/tennis/events/live")
