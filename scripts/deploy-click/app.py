#!/usr/bin/env python3
"""一键部署页：GET /?token= 打开页面，点击后跑 deploy-145.sh，日志走 SSE。"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("DEPLOY_CLICK_HOST", "0.0.0.0")
PORT = int(os.environ.get("DEPLOY_CLICK_PORT", "9009"))
ROOT = Path(os.environ.get("DEPLOY_ROOT", "/opt/yuce/teniesyuce"))
TOKEN_FILE = Path(os.environ.get("DEPLOY_CLICK_TOKEN_FILE", "/opt/yuce/deploy-click/token"))
SCRIPT = ROOT / "scripts" / "deploy-145.sh"

_lock = threading.Lock()
_lines: list[str] = []
_running = False
_exit: int | None = None


def _token() -> str:
    try:
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _append(line: str) -> None:
    global _lines
    with _lock:
        _lines.append(line)
        if len(_lines) > 4000:
            del _lines[:1000]


def _snapshot() -> tuple[list[str], bool, int | None]:
    with _lock:
        return list(_lines), _running, _exit


def _run_deploy() -> None:
    global _running, _exit
    _append(f"\n==> 开始部署 {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    try:
        proc = subprocess.Popen(
            ["sudo", "bash", str(SCRIPT)],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            _append(line)
        code = proc.wait()
    except Exception as exc:
        _append(f"\n[error] {exc}\n")
        code = 1
    _append(f"\n==> 结束 exit={code} {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    with _lock:
        _running = False
        _exit = code


PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>一键部署</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; }
  button { background: #22c55e; color: #052e16; border: 0; border-radius: 8px; padding: 10px 18px; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #log { margin-top: 16px; background: #020617; color: #cbd5e1; border-radius: 8px; padding: 12px; height: 70vh; overflow: auto; white-space: pre-wrap; font: 13px/1.45 ui-monospace, Consolas, monospace; }
  .meta { color: #94a3b8; margin: 8px 0 16px; }
</style>
</head>
<body>
  <h1>一键部署</h1>
  <p class="meta">执行 <code>scripts/deploy-145.sh</code>（git pull + 重建容器）。同一时间只能跑一次。</p>
  <button id="go" type="button">开始部署</button>
  <div id="log">等待操作…</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const logEl = document.getElementById('log');
const btn = document.getElementById('go');
let seen = 0;
function paint(lines, running) {
  if (lines.length) logEl.textContent = lines.join('');
  logEl.scrollTop = logEl.scrollHeight;
  btn.disabled = !!running;
  btn.textContent = running ? '部署中…' : '开始部署';
}
async function poll() {
  const r = await fetch('/api/logs?token=' + encodeURIComponent(token) + '&from=' + seen);
  if (!r.ok) { logEl.textContent = '无法读取日志（token 无效？）'; return; }
  const data = await r.json();
  seen = data.total;
  paint(data.lines, data.running);
}
btn.onclick = async () => {
  btn.disabled = true;
  const r = await fetch('/api/deploy?token=' + encodeURIComponent(token), { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) logEl.textContent = data.error || '启动失败';
  poll();
};
poll();
setInterval(poll, 1000);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def _qs(self) -> dict:
        return parse_qs(urlparse(self.path).query)

    def _ok_token(self) -> bool:
        got = (self._qs().get("token") or [""])[0]
        expect = _token()
        return bool(expect) and got == expect

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            if not self._ok_token():
                self._send(403, b"forbidden", "text/plain; charset=utf-8")
                return
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/logs":
            if not self._ok_token():
                self._send(403, b'{"error":"forbidden"}', "application/json")
                return
            try:
                start = int((self._qs().get("from") or ["0"])[0])
            except ValueError:
                start = 0
            lines, running, code = _snapshot()
            start = max(0, min(start, len(lines)))
            payload = json.dumps(
                {"lines": lines, "total": len(lines), "from": start, "running": running, "exit": code},
                ensure_ascii=False,
            ).encode("utf-8")
            self._send(200, payload, "application/json; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        global _running, _exit, _lines
        path = urlparse(self.path).path
        if path != "/api/deploy":
            self._send(404, b"not found", "text/plain")
            return
        if not self._ok_token():
            self._send(403, b'{"error":"forbidden"}', "application/json")
            return
        with _lock:
            if _running:
                self._send(409, b'{"error":"deploy already running"}', "application/json")
                return
            _running = True
            _exit = None
            _lines = []
        threading.Thread(target=_run_deploy, daemon=True).start()
        self._send(200, b'{"ok":true}', "application/json")


def main() -> None:
    if not _token():
        raise SystemExit(f"missing token file: {TOKEN_FILE}")
    if not SCRIPT.is_file():
        raise SystemExit(f"missing deploy script: {SCRIPT}")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"deploy-click http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
