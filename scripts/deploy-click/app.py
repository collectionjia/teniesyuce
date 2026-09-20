#!/usr/bin/env python3
"""一键部署页：部署按钮 + 可输入命令的终端窗口。"""
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
SHELL_TIMEOUT = int(os.environ.get("DEPLOY_SHELL_TIMEOUT_SEC", "300"))

_lock = threading.Lock()
_lines: list[str] = []
_running = False
_exit: int | None = None

_shell_lock = threading.Lock()
_shell_lines: list[str] = []
_shell_running = False
_shell_cwd = str(ROOT)


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


def _shell_append(line: str) -> None:
    global _shell_lines
    with _shell_lock:
        _shell_lines.append(line)
        if len(_shell_lines) > 4000:
            del _shell_lines[:1000]


def _shell_snapshot() -> tuple[list[str], bool, str]:
    with _shell_lock:
        return list(_shell_lines), _shell_running, _shell_cwd


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


def _run_shell(cmd: str) -> None:
    global _shell_running, _shell_cwd
    cwd = _shell_cwd
    _shell_append(f"$ {cmd}\n")
    try:
        proc = subprocess.Popen(
            ["bash", "-lc", cmd],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, "PWD": cwd, "TERM": "xterm-256color"},
        )
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                _shell_append(line)
            code = proc.wait(timeout=SHELL_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            _shell_append(f"\n[timeout] 超过 {SHELL_TIMEOUT}s，已终止\n")
            code = 124
        # 若命令是 cd，尽量更新会话目录
        if cmd.strip().startswith("cd ") or cmd.strip() == "cd":
            probe = subprocess.run(
                ["bash", "-lc", f"{cmd}; pwd"],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if probe.returncode == 0:
                out = (probe.stdout or "").strip().splitlines()
                if out:
                    with _shell_lock:
                        _shell_cwd = out[-1]
        if code != 0:
            _shell_append(f"[exit {code}]\n")
    except Exception as exc:
        _shell_append(f"[error] {exc}\n")
    finally:
        with _shell_lock:
            _shell_running = False


PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>一键部署</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { margin: 0 0 8px; font-size: 1.4rem; }
  h2 { margin: 0 0 8px; font-size: 1rem; color: #cbd5e1; }
  .meta { color: #94a3b8; margin: 0 0 12px; font-size: 0.9rem; }
  .panel { margin-top: 20px; }
  button, .run-btn {
    background: #22c55e; color: #052e16; border: 0; border-radius: 8px;
    padding: 10px 18px; font-weight: 700; cursor: pointer;
  }
  button:disabled, .run-btn:disabled { opacity: .5; cursor: not-allowed; }
  .log, .term {
    margin-top: 10px; background: #020617; color: #cbd5e1; border-radius: 8px;
    padding: 12px; height: 36vh; overflow: auto; white-space: pre-wrap;
    font: 13px/1.45 ui-monospace, Consolas, monospace;
  }
  .term-wrap { border: 1px solid #1e293b; border-radius: 8px; overflow: hidden; }
  .term { margin: 0; height: 40vh; border-radius: 0; }
  .term-bar {
    display: flex; gap: 8px; align-items: center; padding: 8px; background: #020617;
    border-top: 1px solid #1e293b;
  }
  .cwd { color: #64748b; font: 12px ui-monospace, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 28%; }
  .prompt { color: #22c55e; font: 13px ui-monospace, Consolas, monospace; flex-shrink: 0; }
  #cmd {
    flex: 1; min-width: 0; background: #0f172a; color: #e2e8f0; border: 1px solid #334155;
    border-radius: 6px; padding: 8px 10px; font: 13px ui-monospace, Consolas, monospace;
  }
  #cmd:focus { outline: 1px solid #22c55e; }
</style>
</head>
<body>
  <h1>一键部署</h1>
  <p class="meta">执行 <code>scripts/deploy-145.sh</code>（git pull + 重建容器）。同一时间只能跑一次。</p>
  <button id="go" type="button">开始部署</button>
  <div id="log" class="log">等待操作…</div>

  <div class="panel">
    <h2>命令行</h2>
    <p class="meta">在服务器上执行 bash 命令（需 token）。工作目录可 <code>cd</code> 切换。</p>
    <div class="term-wrap">
      <div id="term" class="term">$ 等待输入…</div>
      <div class="term-bar">
        <span id="cwd" class="cwd"></span>
        <span class="prompt">$</span>
        <input id="cmd" type="text" autocomplete="off" spellcheck="false" placeholder="例如：docker ps"/>
        <button id="run" class="run-btn" type="button">执行</button>
      </div>
    </div>
  </div>

<script>
const token = new URLSearchParams(location.search).get('token') || '';
const logEl = document.getElementById('log');
const btn = document.getElementById('go');
const termEl = document.getElementById('term');
const cwdEl = document.getElementById('cwd');
const cmdEl = document.getElementById('cmd');
const runBtn = document.getElementById('run');
let seen = 0;
let shellSeen = 0;
let hist = [];
let histIdx = -1;

function paint(lines, running) {
  if (lines.length) logEl.textContent = lines.join('');
  logEl.scrollTop = logEl.scrollHeight;
  btn.disabled = !!running;
  btn.textContent = running ? '部署中…' : '开始部署';
}
function paintShell(lines, running, cwd) {
  if (lines.length) termEl.textContent = lines.join('');
  else if (!running) termEl.textContent = '$ 等待输入…';
  termEl.scrollTop = termEl.scrollHeight;
  cwdEl.textContent = cwd || '';
  runBtn.disabled = !!running;
  cmdEl.disabled = !!running;
}
async function poll() {
  const r = await fetch('/api/logs?token=' + encodeURIComponent(token) + '&from=' + seen);
  if (!r.ok) { logEl.textContent = '无法读取日志（token 无效？）'; return; }
  const data = await r.json();
  seen = data.total;
  paint(data.lines, data.running);
}
async function pollShell() {
  const r = await fetch('/api/shell/logs?token=' + encodeURIComponent(token) + '&from=' + shellSeen);
  if (!r.ok) return;
  const data = await r.json();
  shellSeen = data.total;
  paintShell(data.lines, data.running, data.cwd);
}
btn.onclick = async () => {
  btn.disabled = true;
  const r = await fetch('/api/deploy?token=' + encodeURIComponent(token), { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) logEl.textContent = data.error || '启动失败';
  poll();
};
async function runCmd() {
  const cmd = cmdEl.value.trim();
  if (!cmd) return;
  hist.push(cmd);
  histIdx = hist.length;
  cmdEl.value = '';
  runBtn.disabled = true;
  const r = await fetch('/api/shell?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    termEl.textContent += (termEl.textContent.endsWith('\\n') ? '' : '\\n') + '[error] ' + (data.error || '执行失败') + '\\n';
    runBtn.disabled = false;
  }
  pollShell();
}
runBtn.onclick = runCmd;
cmdEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runCmd(); return; }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!hist.length) return;
    histIdx = Math.max(0, histIdx - 1);
    cmdEl.value = hist[histIdx] || '';
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    histIdx = Math.min(hist.length, histIdx + 1);
    cmdEl.value = histIdx >= hist.length ? '' : (hist[histIdx] || '');
  }
});
poll();
pollShell();
setInterval(poll, 1000);
setInterval(pollShell, 800);
cmdEl.focus();
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
        if path == "/api/shell/logs":
            if not self._ok_token():
                self._send(403, b'{"error":"forbidden"}', "application/json")
                return
            lines, running, cwd = _shell_snapshot()
            payload = json.dumps(
                {"lines": lines, "total": len(lines), "running": running, "cwd": cwd},
                ensure_ascii=False,
            ).encode("utf-8")
            self._send(200, payload, "application/json; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        global _running, _exit, _lines, _shell_running
        path = urlparse(self.path).path
        if not self._ok_token():
            self._send(403, b'{"error":"forbidden"}', "application/json")
            return
        if path == "/api/deploy":
            with _lock:
                if _running:
                    self._send(409, b'{"error":"deploy already running"}', "application/json")
                    return
                _running = True
                _exit = None
                _lines = []
            threading.Thread(target=_run_deploy, daemon=True).start()
            self._send(200, b'{"ok":true}', "application/json")
            return
        if path == "/api/shell":
            body = self._read_json()
            cmd = str(body.get("cmd") or "").strip()
            if not cmd:
                self._send(400, b'{"error":"empty command"}', "application/json")
                return
            if len(cmd) > 4000:
                self._send(400, b'{"error":"command too long"}', "application/json")
                return
            with _shell_lock:
                if _shell_running:
                    self._send(409, b'{"error":"shell already running"}', "application/json")
                    return
                _shell_running = True
            threading.Thread(target=_run_shell, args=(cmd,), daemon=True).start()
            self._send(200, b'{"ok":true}', "application/json")
            return
        self._send(404, b"not found", "text/plain")


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
