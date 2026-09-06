#!/usr/bin/env python3
"""Apply all Sofascore monitor patches on the scraper host."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PATCHES = [
    "patch_monitor_server.py",
    "patch_schedule.py",
    "patch_sofascore_client.py",
    "patch_sofascore_proxy.py",
    "patch_top100_bundle.py",
    "patch_monitor_errors.py",
    "patch_collect_log_error.py",
]


def main() -> int:
    failed = False
    for name in PATCHES:
        script = ROOT / name
        if not script.exists():
            print(f"[skip] missing {name}")
            continue
        print(f"[run] {name}")
        rc = subprocess.call([sys.executable, str(script)])
        if rc != 0:
            print(f"[fail] {name} exit {rc}")
            failed = True
    if failed:
        return 1
    print("all patches applied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
