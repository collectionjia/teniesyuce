#!/usr/bin/env python3
"""Local OpenAI-compatible proxy for TokenFoundryX.

Upstream /v1/chat/completions is currently broken (all models route to a dead
claude-sonnet-4-5 channel). /v1/responses works, so this proxy accepts Cursor's
chat/completions calls and relays them through /v1/responses.
"""

from __future__ import annotations

import json
import os
import threading
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

UPSTREAM = os.environ.get("TFX_UPSTREAM", "https://www.tokenfoundryx.com").rstrip("/")
API_KEY = os.environ.get(
    "TFX_API_KEY",
    "sk-SsvDOM3Pl9uJBiRIPK5rSKIIZSOnYfHu78MNV9Tykm1SuWy6",
)
HOST = os.environ.get("TFX_PROXY_HOST", "127.0.0.1")
PORT = int(os.environ.get("TFX_PROXY_PORT", "8787"))
DEFAULT_MODEL = os.environ.get("TFX_DEFAULT_MODEL", "gpt-5.6-sol")


def upstream_request(
    method: str,
    path: str,
    body: bytes | None = None,
    stream: bool = False,
    timeout: float = 180,
):
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
    }
    req = urllib.request.Request(
        UPSTREAM + path,
        data=body,
        headers=headers,
        method=method,
    )
    return urllib.request.urlopen(req, timeout=timeout)


def messages_to_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert OpenAI chat messages to Responses API input items."""
    items: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role") or "user"
        content = msg.get("content")

        if role == "system":
            # Responses prefers instructions; keep as user context if needed.
            text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
            items.append(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": f"[system]\n{text}"}],
                }
            )
            continue

        if role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": msg.get("tool_call_id") or msg.get("id") or "",
                    "output": content if isinstance(content, str) else json.dumps(content, ensure_ascii=False),
                }
            )
            continue

        if role == "assistant" and msg.get("tool_calls"):
            for tc in msg["tool_calls"]:
                fn = tc.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": tc.get("id") or "",
                        "name": fn.get("name") or "",
                        "arguments": fn.get("arguments") or "{}",
                    }
                )
            # also keep assistant text if present
            if content:
                text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                items.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text}],
                    }
                )
            continue

        parts: list[dict[str, Any]] = []
        if isinstance(content, str):
            ctype = "output_text" if role == "assistant" else "input_text"
            parts.append({"type": ctype, "text": content})
        elif isinstance(content, list):
            for p in content:
                if not isinstance(p, dict):
                    continue
                ptype = p.get("type")
                if ptype == "text":
                    ctype = "output_text" if role == "assistant" else "input_text"
                    parts.append({"type": ctype, "text": p.get("text") or ""})
                elif ptype == "image_url":
                    url = ((p.get("image_url") or {}).get("url")) or ""
                    parts.append({"type": "input_image", "image_url": url})
                else:
                    parts.append(p)
        else:
            ctype = "output_text" if role == "assistant" else "input_text"
            parts.append({"type": ctype, "text": "" if content is None else str(content)})

        mapped_role = "assistant" if role == "assistant" else "user"
        items.append({"role": mapped_role, "content": parts})
    return items


def convert_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    out = []
    for t in tools:
        if t.get("type") == "function" and "function" in t:
            fn = t["function"]
            out.append(
                {
                    "type": "function",
                    "name": fn.get("name"),
                    "description": fn.get("description") or "",
                    "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
                }
            )
        else:
            out.append(t)
    return out


def extract_text_and_tools(resp: dict[str, Any]):
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for item in resp.get("output") or []:
        itype = item.get("type")
        if itype == "message":
            for c in item.get("content") or []:
                if c.get("type") in ("output_text", "text"):
                    text_parts.append(c.get("text") or "")
        elif itype == "function_call":
            tool_calls.append(
                {
                    "id": item.get("call_id") or item.get("id") or f"call_{len(tool_calls)}",
                    "type": "function",
                    "function": {
                        "name": item.get("name") or "",
                        "arguments": item.get("arguments") or "{}",
                    },
                }
            )
    return "".join(text_parts), tool_calls


def responses_to_chat(resp: dict[str, Any], requested_model: str) -> dict[str, Any]:
    text, tool_calls = extract_text_and_tools(resp)
    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    finish = "stop"
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish = "tool_calls"
        if not text:
            message["content"] = None

    usage = resp.get("usage") or {}
    return {
        "id": resp.get("id") or "chatcmpl-proxy",
        "object": "chat.completion",
        "created": resp.get("created_at") or 0,
        "model": requested_model or resp.get("model") or DEFAULT_MODEL,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish,
            }
        ],
        "usage": {
            "prompt_tokens": usage.get("input_tokens") or 0,
            "completion_tokens": usage.get("output_tokens") or 0,
            "total_tokens": usage.get("total_tokens") or 0,
        },
    }


def build_responses_body(chat_body: dict[str, Any]) -> dict[str, Any]:
    messages = chat_body.get("messages") or []
    instructions = None
    non_system = []
    for m in messages:
        if m.get("role") == "system" and instructions is None and isinstance(m.get("content"), str):
            instructions = m["content"]
        else:
            non_system.append(m)

    body: dict[str, Any] = {
        "model": chat_body.get("model") or DEFAULT_MODEL,
        "input": messages_to_input(non_system),
        "stream": bool(chat_body.get("stream")),
    }
    if instructions:
        body["instructions"] = instructions

    tools = convert_tools(chat_body.get("tools"))
    if tools:
        body["tools"] = tools
    if chat_body.get("tool_choice") is not None:
        body["tool_choice"] = chat_body["tool_choice"]

    # map token limits
    if chat_body.get("max_tokens") is not None:
        body["max_output_tokens"] = chat_body["max_tokens"]
    elif chat_body.get("max_completion_tokens") is not None:
        body["max_output_tokens"] = chat_body["max_completion_tokens"]

    for k in ("temperature", "top_p"):
        if chat_body.get(k) is not None:
            body[k] = chat_body[k]
    return body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[proxy] {self.address_string()} {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/"):
            self._send(200, b'{"ok":true,"upstream":"%s"}' % UPSTREAM.encode())
            return
        if path == "/v1/models":
            try:
                with upstream_request("GET", "/v1/models") as resp:
                    data = resp.read()
                self._send(resp.status, data)
            except Exception as e:
                self._send(502, json.dumps({"error": {"message": str(e)}}).encode())
            return
        self._send(404, b'{"error":{"message":"not found"}}')

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            if path == "/v1/chat/completions":
                self._handle_chat()
                return
            if path == "/v1/responses":
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                with upstream_request("POST", "/v1/responses", body=body) as resp:
                    data = resp.read()
                self._send(resp.status, data)
                return
            self._send(404, b'{"error":{"message":"not found"}}')
        except urllib.error.HTTPError as e:
            err = e.read()
            self._send(e.code, err or json.dumps({"error": {"message": str(e)}}).encode())
        except Exception as e:
            traceback.print_exc()
            self._send(500, json.dumps({"error": {"message": str(e)}}).encode())

    def _handle_chat(self) -> None:
        chat_body = self._read_json()
        requested_model = chat_body.get("model") or DEFAULT_MODEL
        stream = bool(chat_body.get("stream"))
        resp_body = build_responses_body(chat_body)
        payload = json.dumps(resp_body).encode("utf-8")

        if not stream:
            with upstream_request("POST", "/v1/responses", body=payload, stream=False) as resp:
                raw = resp.read().decode("utf-8", "replace")
            data = json.loads(raw)
            if data.get("error"):
                self._send(500, json.dumps(data).encode())
                return
            out = responses_to_chat(data, requested_model)
            self._send(200, json.dumps(out, ensure_ascii=False).encode("utf-8"))
            return

        # streaming
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        # Prefer upstream streaming; fall back to non-stream chunking.
        resp_body_stream = dict(resp_body)
        resp_body_stream["stream"] = True
        payload_stream = json.dumps(resp_body_stream).encode("utf-8")

        try:
            with upstream_request("POST", "/v1/responses", body=payload_stream, stream=True) as resp:
                buf = b""
                sent_role = False
                while True:
                    chunk = resp.read(1024)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        line = line.strip()
                        if not line or not line.startswith(b"data:"):
                            continue
                        data_s = line[5:].strip()
                        if data_s == b"[DONE]":
                            continue
                        try:
                            evt = json.loads(data_s.decode("utf-8"))
                        except Exception:
                            continue
                        etype = evt.get("type")
                        if etype == "response.output_text.delta":
                            delta_text = evt.get("delta") or ""
                            delta: dict[str, Any] = {"content": delta_text}
                            if not sent_role:
                                delta = {"role": "assistant", "content": delta_text}
                                sent_role = True
                            frame = {
                                "id": "chatcmpl-proxy",
                                "object": "chat.completion.chunk",
                                "model": requested_model,
                                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                            }
                            self.wfile.write(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n".encode())
                            self.wfile.flush()
                        elif etype in ("response.completed", "response.incomplete"):
                            frame = {
                                "id": "chatcmpl-proxy",
                                "object": "chat.completion.chunk",
                                "model": requested_model,
                                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                            }
                            self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())
                            self.wfile.flush()
                        elif etype == "response.output_item.done" and (evt.get("item") or {}).get("type") == "function_call":
                            item = evt["item"]
                            tc = {
                                "id": item.get("call_id") or item.get("id") or "call_0",
                                "type": "function",
                                "function": {
                                    "name": item.get("name") or "",
                                    "arguments": item.get("arguments") or "{}",
                                },
                            }
                            delta = {"tool_calls": [{"index": 0, **tc}]}
                            if not sent_role:
                                delta = {"role": "assistant", "content": None, "tool_calls": [{"index": 0, **tc}]}
                                sent_role = True
                            frame = {
                                "id": "chatcmpl-proxy",
                                "object": "chat.completion.chunk",
                                "model": requested_model,
                                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                            }
                            self.wfile.write(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n".encode())
                            self.wfile.flush()
                        elif etype == "error" or evt.get("error"):
                            err = evt.get("error") or evt
                            frame = {
                                "id": "chatcmpl-proxy",
                                "object": "chat.completion.chunk",
                                "model": requested_model,
                                "choices": [
                                    {
                                        "index": 0,
                                        "delta": {"content": f"[upstream error] {err}"},
                                        "finish_reason": "stop",
                                    }
                                ],
                            }
                            self.wfile.write(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n".encode())
                            self.wfile.flush()
        except Exception:
            # fallback non-stream
            traceback.print_exc()
            with upstream_request("POST", "/v1/responses", body=json.dumps({**resp_body, "stream": False}).encode(), stream=False) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            text, tool_calls = extract_text_and_tools(data)
            delta: dict[str, Any] = {"role": "assistant", "content": text}
            if tool_calls:
                delta = {"role": "assistant", "content": text or None, "tool_calls": [
                    {"index": i, **tc} for i, tc in enumerate(tool_calls)
                ]}
            frame = {
                "id": "chatcmpl-proxy",
                "object": "chat.completion.chunk",
                "model": requested_model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": "tool_calls" if tool_calls else "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n".encode())

        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"TokenFoundryX proxy listening on http://{HOST}:{PORT}/v1")
    print(f"Upstream: {UPSTREAM}")
    print(f"Default model: {DEFAULT_MODEL}")
    print("Point Cursor Override OpenAI Base URL to this address.")
    server.serve_forever()


if __name__ == "__main__":
    main()
