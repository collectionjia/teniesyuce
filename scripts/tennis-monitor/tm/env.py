"""Monitor paths and env loading."""
from __future__ import annotations

import os
from pathlib import Path

MONITOR_ROOT = Path(__file__).resolve().parent.parent


def resolve_monitor_env_path(path: str | Path | None = None) -> Path:
    """按环境选主 monitor 配置文件（兼容旧调用）。"""
    cands = monitor_env_candidates(path)
    for p in cands:
        if p.exists():
            return p
    return cands[-1] if cands else MONITOR_ROOT / "monitor.env"


def monitor_env_candidates(path: str | Path | None = None) -> list[Path]:
    """高优先级在前；load 时跳过空值，可回落到后续文件补齐 SOFA_HTTP_PROXY。"""
    if path:
        return [Path(path)]
    out: list[Path] = []
    explicit = (os.environ.get("SOFA_MONITOR_ENV_FILE") or "").strip()
    if explicit:
        p = Path(explicit)
        out.append(p if p.is_absolute() else MONITOR_ROOT / p)
        return out
    app_env = (os.environ.get("APP_ENV") or "").strip().lower()
    if app_env == "test":
        out.append(MONITOR_ROOT / "monitor.env.test")
    if app_env in ("production", "prod"):
        out.append(MONITOR_ROOT / "monitor.env.prod")
    out.append(MONITOR_ROOT / "monitor.env")
    return out


def load_monitor_env(path: str | Path | None = None) -> Path | None:
    loaded: list[str] = []
    for p in monitor_env_candidates(path):
        if not p.exists():
            continue
        for raw in p.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip("\r")
            if not val:
                continue  # 空值不写入，便于后续文件补代理 URL
            cur = os.environ.get(key)
            if cur is not None and str(cur).strip() != "":
                continue
            os.environ[key] = val
        loaded.append(p.name)
    if not loaded:
        print("[env] 未找到 monitor 配置（可复制 env.monitor.*.example）")
        return None
    print(f"[env] loaded {' + '.join(loaded)}")
    return MONITOR_ROOT / loaded[0]
