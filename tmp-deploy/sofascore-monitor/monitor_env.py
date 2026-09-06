#!/usr/bin/env python3
"""Load monitor.env into os.environ (strips CRLF)."""
from __future__ import annotations

import os
from pathlib import Path


def load_monitor_env(path: str | Path | None = None) -> None:
    p = Path(path or Path(__file__).resolve().parent / "monitor.env")
    if not p.exists():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ[key.strip()] = val.strip().strip("\r")
