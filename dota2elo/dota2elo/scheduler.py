"""自动调度：macOS launchd / Linux cron。

- install: 生成 plist（或 crontab 行）并加载
- uninstall: 卸载并删除
- status: 当前是否已安装、运行状态
- logs: tail 调度日志

设计上让 `ingest --source auto --limit 5` 周期性跑，
LIMIT 只需要覆盖"自上次以来新增"的比赛；OpenDota proMatches 默认
是按时间倒序的，5 页 = 500 场基本能覆盖一周内的比赛。
"""
from __future__ import annotations

import os
import platform
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple

from .config import BASE_DIR

LAUNCHD_LABEL = "com.dota2elo.ingest"
LAUNCHD_PLIST_NAME = f"{LAUNCHD_LABEL}.plist"
LAUNCHD_PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / LAUNCHD_PLIST_NAME
LOG_PATH = BASE_DIR / "data" / "ingest.log"

DURATION_RE = re.compile(r"^\s*(\d+)\s*([smhd])\s*$", re.IGNORECASE)
DURATION_UNIT_SEC = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(s: str) -> int:
    """'6h' / '30m' / '1d' -> 秒。"""
    m = DURATION_RE.match(s)
    if not m:
        raise ValueError(f"无法解析时长：{s!r}，用 '6h' / '30m' / '1d' 这种")
    return int(m.group(1)) * DURATION_UNIT_SEC[m.group(2).lower()]


def format_duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


# ---------------------- 路径探测 ---------------------- #
def detect_venv_python() -> Path:
    """优先用 .venv/bin/python，否则用当前 python。"""
    venv_py = BASE_DIR / ".venv" / "bin" / "python"
    if venv_py.exists():
        return venv_py
    return Path(sys.executable)


def detect_platform() -> str:
    p = sys.platform
    if p == "darwin":
        return "darwin"
    if p.startswith("linux"):
        return "linux"
    return p


# ---------------------- launchd (macOS) ---------------------- #
def _plist_xml(every_seconds: int, extra_env: dict) -> str:
    wrapper = _ensure_wrapper_script()
    log_out = str(LOG_PATH)
    log_err = str(LOG_PATH.with_suffix(".err"))
    # 关键环境变量（stratz key 等）
    env_lines = []
    for k, v in extra_env.items():
        # 用 CDATA 包裹避免特殊字符问题
        env_lines.append(
            f"      <key>{_xml_escape(k)}</key>\n"
            f"      <string>{_xml_escape(v)}</string>"
        )
    env_block = "\n".join(env_lines) if env_lines else ""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>{_xml_escape(str(wrapper))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/tmp</string>
  <key>StartInterval</key>
  <integer>{every_seconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{_xml_escape(log_out)}</string>
  <key>StandardErrorPath</key>
  <string>{_xml_escape(log_err)}</string>
  <key>EnvironmentVariables</key>
  <dict>
{env_block}
  </dict>
</dict>
</plist>
"""


# 包装脚本：放 ~/.local/bin（不在 Downloads 下，没有 provenance xattr）
# 绕过 macOS launchd 读 venv cfg 的权限问题：
# - 用 SYSTEM python（不在 Downloads 目录），加 PYTHONPATH 指向 venv site-packages
# - 不用 venv 解释器，避免读 pyvenv.cfg
WRAPPER_PATH = Path.home() / ".local" / "bin" / "dota2elo-ingest.sh"


def _system_python() -> str:
    """用 /usr/bin/python3（系统装的，不在 Downloads 下）。"""
    candidates = ["/usr/bin/python3", "/usr/local/bin/python3"]
    for c in candidates:
        if Path(c).exists():
            return c
    return sys.executable


def _ensure_wrapper_script() -> Path:
    """生成/更新包装脚本。返回脚本路径。"""
    py = detect_venv_python()
    # 找 venv 的 site-packages
    venv_root = py.parent.parent  # .venv/bin/python -> .venv
    sp_candidates = [
        venv_root / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages",
        venv_root / "lib" / "site-packages",
    ]
    site_packages = next((p for p in sp_candidates if p.exists()), None)
    if not site_packages:
        raise RuntimeError(f"找不到 venv site-packages: {sp_candidates}")
    run_py = BASE_DIR / "run.py"
    sys_py = _system_python()

    WRAPPER_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 关键：
    # 1) 用系统 python（不读 venv cfg）
    # 2) unset __PYVENV_LAUNCHER__（macOS Python 优先用这个变量定位 venv）
    # 3) 不 cd 到项目目录（launchd 子进程对 Downloads 目录的访问被 TCC 限制），
    #    直接传 run.py 绝对路径
    script = f"""#!/bin/bash
# 自动生成 - 由 dota2elo.scheduler 管理
# 跑 auto-update 管道：ingest → recalibrate → 落盘状态
unset __PYVENV_LAUNCHER__
unset VIRTUAL_ENV
export PYTHONPATH="{site_packages}"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "{sys_py}" "{run_py}" auto-update --source auto --max-pages 5
"""
    WRAPPER_PATH.write_text(script)
    WRAPPER_PATH.chmod(0o755)
    return WRAPPER_PATH


def _xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;"))


def install_launchd(every: str = "6h") -> Path:
    secs = parse_duration(every)
    extra_env = {}
    if os.getenv("STRATZ_API_KEY"):
        extra_env["STRATZ_API_KEY"] = os.environ["STRATZ_API_KEY"]
    if os.getenv("DOTA2ELO_SOURCE"):
        extra_env["DOTA2ELO_SOURCE"] = os.environ["DOTA2ELO_SOURCE"]
    # PATH 必须有，否则 cron/launchd 找不到基础命令
    extra_env["PATH"] = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    LAUNCHD_PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    LAUNCHD_PLIST_PATH.write_text(_plist_xml(secs, extra_env))
    # 加载到 launchd
    subprocess.run(["launchctl", "load", "-w", str(LAUNCHD_PLIST_PATH)], check=False)
    return LAUNCHD_PLIST_PATH


def uninstall_launchd() -> bool:
    if not LAUNCHD_PLIST_PATH.exists():
        return False
    subprocess.run(["launchctl", "unload", str(LAUNCHD_PLIST_PATH)], check=False)
    LAUNCHD_PLIST_PATH.unlink()
    return True


def status_launchd() -> dict:
    out = {"installed": LAUNCHD_PLIST_PATH.exists(), "plist": str(LAUNCHD_PLIST_PATH), "loaded": False, "pid": None}
    if not out["installed"]:
        return out
    r = subprocess.run(["launchctl", "list", LAUNCHD_LABEL], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        # 格式: "PID\tStatus\tLabel"，PID=0/- 表示 loaded 但未运行
        parts = r.stdout.strip().split("\t")
        if parts:
            pid_str = parts[0].strip()
            if pid_str.isdigit():
                pid_val = int(pid_str)
                if pid_val > 0:
                    out["pid"] = pid_val
        out["loaded"] = True
    return out


# ---------------------- cron (Linux) ---------------------- #
CRON_TAG = "# dota2elo-managed"
CRON_FILE = Path.home() / ".dota2elo.cron"


def _cron_line(every_seconds: int, extra_env: dict) -> str:
    """生成 crontab 表达式 + 命令行。"""
    py = detect_venv_python()
    run_py = BASE_DIR / "run.py"
    # 简化：把"每 N 秒"近似成每 N 分钟 / 小时 / 天的 cron 表达式
    if every_seconds < 3600:
        mins = max(1, every_seconds // 60)
        cron_expr = f"*/{mins} * * * *"
    elif every_seconds < 86400:
        hours = max(1, every_seconds // 3600)
        cron_expr = f"0 */{hours} * * *"
    else:
        days = max(1, every_seconds // 86400)
        cron_expr = f"0 0 */{days} * *"

    env_prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in extra_env.items())
    cmd = f"cd {shlex.quote(str(BASE_DIR))} && {env_prefix} {py} {run_py} auto-update --source auto --max-pages 5 >> {LOG_PATH} 2>&1"
    return f"{cron_expr} {cmd}  {CRON_TAG}"


def install_cron(every: str = "6h") -> Path:
    secs = parse_duration(every)
    extra_env = {}
    if os.getenv("STRATZ_API_KEY"):
        extra_env["STRATZ_API_KEY"] = os.environ["STRATZ_API_KEY"]
    if os.getenv("DOTA2ELO_SOURCE"):
        extra_env["DOTA2ELO_SOURCE"] = os.environ["DOTA2ELO_SOURCE"]
    line = _cron_line(secs, extra_env)

    # 写到一个独立文件（方便管理），然后注入 crontab
    existing = ""
    if CRON_FILE.exists():
        existing = CRON_FILE.read_text()
    # 去重：移除旧的 dota2elo 行
    lines = [l for l in existing.splitlines() if CRON_TAG not in l]
    lines.append(line)
    CRON_FILE.write_text("\n".join(lines) + "\n")

    # 注入 crontab
    try:
        current = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
        ct = current.stdout if current.returncode == 0 else ""
    except FileNotFoundError:
        raise RuntimeError("crontab 命令不可用，请安装 cron")

    ct_lines = [l for l in ct.splitlines() if CRON_TAG not in l]
    ct_lines.append(line)
    new_ct = "\n".join(ct_lines) + "\n"
    p = subprocess.run(["crontab", "-"], input=new_ct, text=True, check=False)
    if p.returncode != 0:
        raise RuntimeError(f"crontab 写入失败: {p.stderr}")
    return CRON_FILE


def uninstall_cron() -> bool:
    removed = False
    if CRON_FILE.exists():
        lines = [l for l in CRON_FILE.read_text().splitlines() if CRON_TAG not in l]
        CRON_FILE.write_text("\n".join(lines) + ("\n" if lines else ""))
        removed = True
    # 从 crontab 移除
    r = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
    if r.returncode == 0:
        new_lines = [l for l in r.stdout.splitlines() if CRON_TAG not in l]
        subprocess.run(["crontab", "-"], input="\n".join(new_lines) + "\n", text=True, check=False)
    return removed


def status_cron() -> dict:
    out = {"cron_file": str(CRON_FILE), "in_crontab": False, "line": None}
    if CRON_FILE.exists():
        for l in CRON_FILE.read_text().splitlines():
            if CRON_TAG in l:
                out["line"] = l.replace(CRON_TAG, "").strip()
    r = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
    if r.returncode == 0:
        for l in r.stdout.splitlines():
            if CRON_TAG in l:
                out["in_crontab"] = True
                if not out["line"]:
                    out["line"] = l.replace(CRON_TAG, "").strip()
    return out


# ---------------------- 统一接口 ---------------------- #
def install(every: str = "6h") -> Tuple[str, str]:
    plat = detect_platform()
    if plat == "darwin":
        p = install_launchd(every)
        return ("launchd", f"已安装到 {p}，每 {every} 跑一次")
    if plat == "linux":
        p = install_cron(every)
        return ("cron", f"已安装到 {p} 并写入 crontab，每 {every} 跑一次")
    raise RuntimeError(f"不支持的平台：{plat}。请用 OS 自己的调度器。")


def uninstall() -> bool:
    plat = detect_platform()
    if plat == "darwin":
        return uninstall_launchd()
    if plat == "linux":
        return uninstall_cron()
    return False


def status() -> dict:
    plat = detect_platform()
    out = {"platform": plat, "log": str(LOG_PATH), "log_exists": LOG_PATH.exists()}
    if plat == "darwin":
        out.update(status_launchd())
    elif plat == "linux":
        out.update(status_cron())
    return out


def tail_logs(n: int = 50) -> Optional[str]:
    if not LOG_PATH.exists():
        return None
    # 简单 tail 实现
    with LOG_PATH.open("r", errors="replace") as f:
        lines = f.readlines()
    return "".join(lines[-n:])


# ---------------------- 诊断 ---------------------- #
def doctor() -> List[Dict[str, Any]]:
    """检查调度可能失败的原因，返回问题列表。"""
    issues: List[Dict[str, Any]] = []
    plat = detect_platform()

    if plat == "darwin":
        # 1. 项目在 Downloads？
        if "Downloads" in str(BASE_DIR):
            issues.append({
                "severity": "error",
                "code": "macos-downloads-sandbox",
                "message": "项目在 ~/Downloads 下，macOS 阻止 launchd 子进程读取该目录",
                "fix": "把项目移到 ~/Code/dota2elo 或 ~/Documents/dota2elo，然后重装调度：\n"
                       "  mv ~/Downloads/dota2elo ~/Code/dota2elo\n"
                       "  cd ~/Code/dota2elo && python run.py schedule install",
            })
        # 2. 文件 xattr 检查
        sample = BASE_DIR / "run.py"
        if sample.exists():
            attrs = subprocess.run(["xattr", str(sample)], capture_output=True, text=True).stdout
            if "com.apple.provenance" in attrs:
                issues.append({
                    "severity": "warning",
                    "code": "provenance-xattr",
                    "message": "run.py 有 com.apple.provenance xattr，launchd 子进程可能读不到",
                    "fix": "xattr -cr <项目目录>  (但 macOS 会在后台重打；根本解是移出 Downloads)",
                })
        # 3. venv site-packages 可读性
        venv_py = detect_venv_python()
        if venv_py.exists():
            venv_root = venv_py.parent.parent
            sp = venv_root / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
            if sp.exists():
                # 测试能否在 launchd 上下文读 site-packages
                test_file = sp / "fastapi" / "__init__.py"
                if test_file.exists():
                    r = subprocess.run(
                        ["launchctl", "getenv", "PATH"], capture_output=True, text=True
                    )
                    issues.append({
                        "severity": "info",
                        "code": "launchctl-context",
                        "message": "launchd 上下文是受限的 shell，与终端会话 TCC 权限不同",
                    })
    elif plat == "linux":
        # 简单检查 crontab 可用
        r = subprocess.run(["which", "crontab"], capture_output=True)
        if r.returncode != 0:
            issues.append({
                "severity": "error",
                "code": "no-crontab",
                "message": "crontab 命令不可用",
                "fix": "安装 cron 包（apt install cron / yum install cronie）",
            })

    # 通用：STRATZ_API_KEY
    if not os.getenv("STRATZ_API_KEY") and "STRATZ_API_KEY" not in os.environ:
        # 不在 plist 里的额外提示
        if plat == "darwin" and LAUNCHD_PLIST_PATH.exists():
            plist_content = LAUNCHD_PLIST_PATH.read_text() if LAUNCHD_PLIST_PATH.exists() else ""
            if "STRATZ_API_KEY" not in plist_content:
                issues.append({
                    "severity": "info",
                    "code": "no-stratz-key",
                    "message": "未设置 STRATZ_API_KEY，调度任务将只走 OpenDota",
                    "fix": "export STRATZ_API_KEY=xxx && python run.py schedule install（重装捕获环境）",
                })

    return issues
