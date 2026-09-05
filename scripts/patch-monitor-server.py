#!/usr/bin/env python3
from pathlib import Path

p = Path("/home/ubuntu/sofascore-tennis-scraper/monitor_server.py")
text = p.read_text(encoding="utf-8")

old_block = """            accept = self.headers.get("Accept", "")
            qs = parse_qs(urlparse(self.path).query)
            page_token = qs.get("token", [""])[0]
            if path == "/" and "text/html" in accept and "application/json" not in accept:
                self._html(200, _render_dashboard(st, page_token))
            else:
                self._json(200, st)"""

new_block = """            accept = self.headers.get("Accept", "").lower()
            qs = parse_qs(urlparse(self.path).query)
            page_token = qs.get("token", [""])[0]
            fmt = (qs.get("format", [""])[0] or "").lower()
            if path == "/" and fmt != "json" and (
                fmt == "html"
                or "text/html" in accept
                or not accept.strip()
                or accept.strip() == "*/*"
            ):
                self._html(200, _render_dashboard(st, page_token))
            else:
                self._json(200, st)"""

if old_block not in text:
    old_block = old_block.replace("\n", "\r\n")
    new_block = new_block.replace("\n", "\r\n")

if old_block not in text:
    raise SystemExit("patch target not found")

p.write_text(text.replace(old_block, new_block), encoding="utf-8")
print("patched ok")
