#!/usr/bin/env python3
"""一键部署页。只跑固定脚本，不接受任意命令。"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("DEPLOY_HOST", "0.0.0.0")
PORT = int(os.environ.get("DEPLOY_PORT", "9102"))
ROOT = Path(os.environ.get("DEPLOY_ROOT", "/opt/yucebid"))
TOKEN_FILE = Path(os.environ.get("DEPLOY_TOKEN_FILE", "/opt/yucebid/.deploy-web-token"))

TARGETS = {
    "test": ["bash", "scripts/docker-deploy-test-all.sh"],
    "prod": ["bash", "scripts/docker-deploy-prod-all.sh"],
}

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
    with _lock:
        _lines.append(line)
        if len(_lines) > 4000:
            del _lines[:1000]


def _snapshot() -> tuple[list[str], bool, int | None]:
    with _lock:
        return list(_lines), _running, _exit


def _stream(cmd: list[str]) -> int:
    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        _append(line)
    return proc.wait()


def _run(target: str) -> None:
    global _running, _exit
    cmd = TARGETS[target]
    _append(f"\n==> {target} {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    code = 1
    try:
        _append("==> git pull --ff-only\n")
        code = _stream(["git", "pull", "--ff-only"])
        if code == 0:
            _append(f"==> {' '.join(cmd)}\n")
            code = _stream(cmd)
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
  h1 { margin: 0 0 8px; font-size: 1.4rem; }
  .meta { color: #94a3b8; margin: 0 0 14px; font-size: 0.9rem; }
  button {
    border: 0; border-radius: 8px; padding: 10px 18px; font-weight: 700; cursor: pointer; margin-right: 8px;
  }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #test { background: #22c55e; color: #052e16; }
  #prod { background: #f59e0b; color: #451a03; }
  .log {
    margin-top: 14px; background: #020617; color: #cbd5e1; border-radius: 8px;
    padding: 12px; height: 70vh; overflow: auto; white-space: pre-wrap;
    font: 13px/1.45 ui-monospace, Consolas, monospace;
  }
</style>
</head>
<body>
  <h1>一键部署</h1>
  <p class="meta">目录 <code>__ROOT__</code>。先 <code>git pull --ff-only</code>，再跑对应发布脚本。同一时间只能跑一次。</p>
  <button id="test" type="button">部署测试 :9018</button>
  <button id="prod" type="button">部署生产 :9001</button>
  <div id="log" class="log">等待操作…</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const logEl = document.getElementById('log');
const buttons = [document.getElementById('test'), document.getElementById('prod')];
let seen = 0;
function paint(lines, running) {
  if (lines.length) logEl.textContent = lines.join('');
  logEl.scrollTop = logEl.scrollHeight;
  for (const b of buttons) b.disabled = !!running;
}
async function poll() {
  const r = await fetch('/api/logs?token=' + encodeURIComponent(token));
  if (!r.ok) { logEl.textContent = '无法读取日志（token 无效）'; return; }
  const data = await r.json();
  seen = data.total;
  paint(data.lines, data.running);
}
async function go(target) {
  for (const b of buttons) b.disabled = true;
  const r = await fetch('/api/deploy?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) logEl.textContent = data.error || '启动失败';
  poll();
}
document.getElementById('test').onclick = () => go('test');
document.getElementById('prod').onclick = () => {
  if (confirm('确认部署生产？')) go('prod');
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

    def _read_json(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return {}

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
                self._send(403, "forbidden\n".encode(), "text/plain; charset=utf-8")
                return
            html = PAGE.replace("__ROOT__", str(ROOT))
            self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/logs":
            if not self._ok_token():
                self._send(403, b'{"error":"forbidden"}', "application/json")
                return
            lines, running, code = _snapshot()
            payload = json.dumps(
                {"lines": lines, "total": len(lines), "running": running, "exit": code},
                ensure_ascii=False,
            ).encode("utf-8")
            self._send(200, payload, "application/json; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        global _running, _exit
        path = urlparse(self.path).path
        if not self._ok_token():
            self._send(403, b'{"error":"forbidden"}', "application/json")
            return
        if path != "/api/deploy":
            self._send(404, b"not found", "text/plain")
            return
        target = str(self._read_json().get("target") or "")
        if target not in TARGETS:
            self._send(400, b'{"error":"target must be test or prod"}', "application/json")
            return
        with _lock:
            if _running:
                self._send(409, b'{"error":"deploy already running"}', "application/json")
                return
            _running = True
            _exit = None
            _lines.clear()
        threading.Thread(target=_run, args=(target,), daemon=True).start()
        self._send(200, b'{"ok":true}', "application/json")


def main() -> None:
    if not _token():
        raise SystemExit(f"missing token file: {TOKEN_FILE}")
    if not ROOT.is_dir():
        raise SystemExit(f"missing repo: {ROOT}")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"deploy-web http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
