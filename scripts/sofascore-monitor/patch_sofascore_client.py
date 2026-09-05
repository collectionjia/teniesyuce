"""Add retry + configurable timeout to sofascore_client.py."""
from __future__ import annotations

from pathlib import Path

P = Path("/home/ubuntu/sofascore-tennis-scraper/sofascore_client.py")
text = P.read_text(encoding="utf-8")

CONFIG_BLOCK = """_REQUEST_TIMEOUT = int(os.environ.get("SOFA_REQUEST_TIMEOUT_SEC", "90"))
_REQUEST_RETRIES = max(1, int(os.environ.get("SOFA_REQUEST_RETRIES", "3")))
_RETRY_BACKOFF = float(os.environ.get("SOFA_REQUEST_RETRY_BACKOFF_SEC", "3.0"))


def _is_retryable_request_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    needles = (
        "timeout",
        "timed out",
        "connection",
        "curl: (7)",
        "curl: (28)",
        "curl: (35)",
        "curl: (52)",
        "curl: (56)",
    )
    return any(n in msg for n in needles)


"""

GET_OLD = """    def _get(self, url: str, *, referer: str | None = None, timeout: int = 25) -> requests.Response:
        self._throttle()
        if referer:
            self.session.headers["Referer"] = referer
        self._last_request_at = time.time()
        resp = self.session.get(url, timeout=timeout)
        return resp"""

GET_NEW = """    def _get(self, url: str, *, referer: str | None = None, timeout: int | None = None) -> requests.Response:
        req_timeout = _REQUEST_TIMEOUT if timeout is None else timeout
        last_exc: Exception | None = None
        for attempt in range(_REQUEST_RETRIES):
            try:
                self._throttle()
                if referer:
                    self.session.headers["Referer"] = referer
                self._last_request_at = time.time()
                return self.session.get(url, timeout=req_timeout)
            except Exception as exc:
                last_exc = exc
                if attempt + 1 >= _REQUEST_RETRIES or not _is_retryable_request_error(exc):
                    raise
                wait = _RETRY_BACKOFF * (attempt + 1)
                print(f"[sofascore] retry {attempt + 1}/{_REQUEST_RETRIES} in {wait:.0f}s: {exc}")
                time.sleep(wait)
        if last_exc:
            raise last_exc
        raise RuntimeError("request failed")"""

API_GET_OLD = '            resp = self._get(url, referer=referer, timeout=60)'
API_GET_NEW = "            resp = self._get(url, referer=referer)"

TEAM_GET_OLD = '            resp = self._get(url, referer="https://www.sofascore.com/tennis", timeout=60)'


def apply() -> None:
    text2 = text
    if "_REQUEST_TIMEOUT" not in text2:
        anchor = "_MIN_INTERVAL = float"
        idx = text2.find(anchor)
        if idx == -1:
            raise SystemExit("anchor for config block not found")
        line_end = text2.find("\n", idx)
        text2 = text2[: line_end + 1] + "\n" + CONFIG_BLOCK + text2[line_end + 1 :]
    if "_is_retryable_request_error" not in text2:
        text2 = text2.replace(GET_OLD, GET_NEW, 1)
    elif "for attempt in range(_REQUEST_RETRIES)" not in text2:
        text2 = text2.replace(GET_OLD, GET_NEW, 1)
    text2 = text2.replace(API_GET_OLD, API_GET_NEW)
    text2 = text2.replace(TEAM_GET_OLD, '            resp = self._get(url, referer="https://www.sofascore.com/tennis")')
    P.write_text(text2, encoding="utf-8")
    print("sofascore_client.py patched")


if __name__ == "__main__":
    apply()
