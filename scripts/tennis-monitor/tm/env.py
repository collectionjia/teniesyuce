"""Monitor paths and env loading."""
from __future__ import annotations

import os
from pathlib import Path

MONITOR_ROOT = Path(__file__).resolve().parent.parent


def load_monitor_env(path: str | Path | None = None) -> None:
    p = Path(path or MONITOR_ROOT / "monitor.env")
    if not p.exists():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        if key in os.environ:
            continue
        os.environ[key] = val.strip().strip("\r")
