#!/usr/bin/env python3
"""JSON-lines worker: Node 发 {"cmd":"get","path":"..."} → Sofascore mobile API（token/init + Bearer）。"""
from __future__ import annotations

import json
import sys

from tm.clients.sofascore import SofascoreClient


def main() -> None:
    client: SofascoreClient | None = None

    def client_or_create() -> SofascoreClient:
        nonlocal client
        if client is None:
            client = SofascoreClient()
            print("[sofa_worker] using Sofascore mobile API", file=sys.stderr, flush=True)
        return client

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": f"bad json: {exc}"}), flush=True)
            continue
        cmd = req.get("cmd")
        if cmd == "quit":
            break
        if cmd != "get":
            print(json.dumps({"ok": False, "error": f"unknown cmd: {cmd}"}), flush=True)
            continue
        path = str(req.get("path") or "").strip()
        if not path:
            print(json.dumps({"ok": False, "error": "empty path"}), flush=True)
            continue
        try:
            # referer 忽略：mobile API 不需要
            data = client_or_create()._api_get(path)
            print(json.dumps({"ok": True, "data": data}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)

    if client is not None:
        try:
            client.session.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
