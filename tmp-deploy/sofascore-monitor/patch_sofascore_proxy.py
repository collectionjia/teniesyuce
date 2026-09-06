"""Patch sofascore_client.py: HTTP/HTTPS proxy for Sofascore API requests."""
from __future__ import annotations

from pathlib import Path

P = Path("/home/ubuntu/sofascore-tennis-scraper/sofascore_client.py")
text = P.read_text(encoding="utf-8")

PROXY_HELPER = '''

def _sofa_proxy_map() -> dict[str, str]:
    """Read proxy from SOFA_* or standard HTTP(S)_PROXY env vars."""
    http_p = (
        os.environ.get("SOFA_HTTP_PROXY")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or ""
    ).strip()
    https_p = (
        os.environ.get("SOFA_HTTPS_PROXY")
        or os.environ.get("SOFA_HTTP_PROXY")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or http_p
    ).strip()
    out: dict[str, str] = {}
    if http_p:
        out["http"] = http_p
    if https_p:
        out["https"] = https_p
    return out

'''

INIT_PROXY_OLD = "        self.session = requests.Session()"
INIT_PROXY_NEW = """        self.session = requests.Session()
        _proxies = _sofa_proxy_map()
        if _proxies:
            self.session.proxies.update(_proxies)
            safe = _proxies.get("https") or _proxies.get("http") or ""
            if "@" in safe:
                safe = safe.split("@", 1)[-1]
            print(f"[sofascore] using proxy {safe}")"""

if "_sofa_proxy_map" not in text:
    anchor = "class SofascoreClient"
    idx = text.find(anchor)
    if idx == -1:
        raise SystemExit("SofascoreClient class not found")
    text = text[:idx] + PROXY_HELPER + "\n" + text[idx:]
    print("added _sofa_proxy_map")
else:
    print("_sofa_proxy_map exists")

if "self.session.proxies.update" not in text:
    if INIT_PROXY_OLD not in text:
        raise SystemExit("session init anchor not found")
    text = text.replace(INIT_PROXY_OLD, INIT_PROXY_NEW, 1)
    print("wired proxy into SofascoreClient.__init__")
else:
    print("proxy already wired")

P.write_text(text, encoding="utf-8")
print("patch_sofascore_proxy done")
