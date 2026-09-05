#!/usr/bin/env python3
"""CodeBuddy HTTP API 简易客户端。"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_BASE = "http://127.0.0.1:8080"
DEFAULT_HEADER = {"X-CodeBuddy-Request": "1", "Content-Type": "application/json"}


def _request(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    token: str | None = None,
    timeout: float = 120,
) -> dict[str, Any]:
    headers = dict(DEFAULT_HEADER)
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"无法连接 {url}: {exc}") from exc


def health(base: str) -> dict[str, Any]:
    return _request("GET", f"{base}/api/v1/health")


def dispatch_job(
    base: str,
    prompt: str,
    cwd: str | None = None,
    model: str | None = None,
    agent: str = "minimal",
    permission_mode: str = "dontAsk",
    token: str | None = None,
) -> str:
    payload: dict[str, Any] = {
        "prompt": prompt,
        "agent": agent,
        "permissionMode": permission_mode,
    }
    if cwd:
        payload["cwd"] = cwd
    if model:
        payload["model"] = model

    result = _request("POST", f"{base}/api/v1/jobs", payload, token=token)
    data = result.get("data") or result
    job_id = data.get("id") or data.get("jobId")
    if not job_id:
        raise RuntimeError(f"创建 job 失败: {result}")
    return str(job_id)


def read_stream(base: str, job_id: str, token: str | None = None, wait_sec: int = 120) -> str:
    url = f"{base}/api/v1/jobs/{job_id}/stream"
    headers = {"X-CodeBuddy-Request": "1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = Request(url, headers=headers, method="GET")
    chunks: list[str] = []
    deadline = time.time() + wait_sec

    try:
        with urlopen(req, timeout=wait_sec) as resp:
            while time.time() < deadline:
                line = resp.readline().decode("utf-8", errors="replace")
                if not line:
                    break
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    chunks.append(payload)
                    continue

                text = _extract_text(event)
                if text:
                    chunks.append(text)
    except Exception as exc:
        raise RuntimeError(f"读取 stream 失败: {exc}") from exc

    transcript = _request("GET", f"{base}/api/v1/jobs/{job_id}/transcript", token=token)
    text = _extract_transcript(transcript)
    return text or "".join(chunks)


def ask(
    prompt: str,
    base: str = DEFAULT_BASE,
    cwd: str | None = None,
    model: str | None = None,
    token: str | None = None,
) -> str:
    status = health(base)
    if "error" in status and status["error"].get("code") == "Missing required header":
        raise RuntimeError("服务可用，但缺少 X-CodeBuddy-Request 头")

    job_id = dispatch_job(base, prompt, cwd=cwd, model=model, token=token)
    print(f"job id: {job_id}", file=sys.stderr)
    return read_stream(base, job_id, token=token)


def _extract_text(event: dict[str, Any]) -> str:
    for key in ("text", "content", "delta"):
        val = event.get(key)
        if isinstance(val, str) and val.strip():
            return val
    payload = event.get("payload")
    if isinstance(payload, dict):
        for key in ("text", "content"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                return val
    return ""


def _extract_transcript(body: dict[str, Any]) -> str:
    data = body.get("data") or body
    updates = data.get("updates") or []
    parts: list[str] = []
    for item in updates:
        if not isinstance(item, dict):
            continue
        for key in ("text", "content"):
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                parts.append(val)
        msg = item.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                parts.append(content)
    return "\n".join(parts).strip()


def send_run(prompt: str, base: str = DEFAULT_BASE, token: str | None = None) -> str:
    run_id = str(uuid.uuid4())
    payload = {
        "id": run_id,
        "type": "message",
        "source": {
            "platform": "generic",
            "sender": {"id": "local-client", "name": "Local Client"},
            "conversation": {"id": run_id, "type": "direct"},
        },
        "payload": {"text": prompt},
    }
    result = _request("POST", f"{base}/api/v1/runs", payload, token=token)
    data = result.get("data") or result
    actual_run_id = str(data.get("runId") or run_id)
    return read_run_stream(base, actual_run_id, token=token)


def read_run_stream(base: str, run_id: str, token: str | None = None, wait_sec: int = 120) -> str:
    url = f"{base}/api/v1/runs/{run_id}/stream"
    headers = {"X-CodeBuddy-Request": "1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = Request(url, headers=headers, method="GET")
    chunks: list[str] = []
    deadline = time.time() + wait_sec

    with urlopen(req, timeout=wait_sec) as resp:
        while time.time() < deadline:
            line = resp.readline().decode("utf-8", errors="replace")
            if not line:
                break
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                event = json.loads(payload)
                text = _extract_text(event)
                if text:
                    chunks.append(text)
            except json.JSONDecodeError:
                chunks.append(payload)
    return "".join(chunks).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description="CodeBuddy HTTP API 本地客户端")
    parser.add_argument("prompt", nargs="?", default="你好，请用一句话回复")
    parser.add_argument("--base", default=DEFAULT_BASE, help="CodeBuddy 服务地址")
    parser.add_argument("--cwd", default=None, help="job 工作目录")
    parser.add_argument("--model", default=None, help="指定模型")
    parser.add_argument("--token", default=None, help="Bearer token（启用密码认证时需要）")
    parser.add_argument("--mode", choices=["job", "run"], default="job", help="调用模式")
    args = parser.parse_args()

    try:
        if args.mode == "run":
            answer = send_run(args.prompt, base=args.base, token=args.token)
        else:
            answer = ask(args.prompt, base=args.base, cwd=args.cwd, model=args.model, token=args.token)
    except RuntimeError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        sys.exit(1)

    print(answer)


if __name__ == "__main__":
    main()
