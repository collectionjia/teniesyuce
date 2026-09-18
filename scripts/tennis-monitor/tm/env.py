"""Monitor paths and env loading."""
from __future__ import annotations

import os
from pathlib import Path

MONITOR_ROOT = Path(__file__).resolve().parent.parent


def resolve_monitor_env_path(path: str | Path | None = None) -> Path:
    """按环境选 monitor 配置文件（均不进 Git）。

    优先级:
      1. 显式 path / SOFA_MONITOR_ENV_FILE
      2. APP_ENV=test → monitor.env.test
      3. APP_ENV=production|prod → monitor.env.prod
      4. 回退 monitor.env
    """
    if path:
        return Path(path)
    explicit = (os.environ.get("SOFA_MONITOR_ENV_FILE") or "").strip()
    if explicit:
        p = Path(explicit)
        return p if p.is_absolute() else MONITOR_ROOT / p
    app_env = (os.environ.get("APP_ENV") or "").strip().lower()
    if app_env == "test":
        cand = MONITOR_ROOT / "monitor.env.test"
        if cand.exists():
            return cand
    if app_env in ("production", "prod"):
        cand = MONITOR_ROOT / "monitor.env.prod"
        if cand.exists():
            return cand
    return MONITOR_ROOT / "monitor.env"


def load_monitor_env(path: str | Path | None = None) -> Path | None:
    p = resolve_monitor_env_path(path)
    if not p.exists():
        print(f"[env] 未找到 monitor 配置: {p}（可复制 env.monitor.*.example）")
        return None
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip("\r")
        # 进程里已有非空值则保留；空字符串视为未配置，允许被 monitor.env 覆盖
        cur = os.environ.get(key)
        if cur is not None and str(cur).strip() != "":
            continue
        os.environ[key] = val
    print(f"[env] loaded {p.name}")
    return p
