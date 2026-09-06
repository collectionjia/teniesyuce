"""Extract collect errors from log file when stderr is empty (run_collect.sh redirects output)."""
from __future__ import annotations

from pathlib import Path

P = Path("/home/ubuntu/sofascore-tennis-scraper/monitor_server.py")
text = P.read_text(encoding="utf-8")

HELPERS = '''

def _extract_collect_error(log_path: Path | None) -> str | None:
    if not log_path or not log_path.exists():
        return None
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        s = line.strip()
        if not s or s.startswith("==="):
            continue
        low = s.lower()
        if any(
            k in low
            for k in (
                "traceback",
                "error",
                "failed",
                "curl:",
                "exception",
                "forbidden",
                "timeout",
                "timed out",
            )
        ):
            return s
    return lines[-1].strip() if lines else None


'''

COLLECT_BLOCK_OLD = """        log = _latest_log()
        with _lock:
            _last_run.update({
                "status": "success" if code == 0 else "failed",
                "finished_at": _now(),
                "exit_code": code,
                "log_file": str(log) if log else None,
                "error": _friendly_error(err) if err else None,
            })"""

COLLECT_BLOCK_NEW = """        log = _latest_log()
        if code != 0 and not err and log:
            err = _extract_collect_error(log)
        with _lock:
            _last_run.update({
                "status": "success" if code == 0 else "failed",
                "finished_at": _now(),
                "exit_code": code,
                "log_file": str(log) if log else None,
                "error": _friendly_error(err) if err else None,
            })"""


def apply() -> None:
    text2 = text
    if "def _extract_collect_error" not in text2:
        anchor = "def _friendly_error"
        text2 = text2.replace(anchor, HELPERS + anchor, 1)
    if "if code != 0 and not err and log:" not in text2:
        text2 = text2.replace(COLLECT_BLOCK_OLD, COLLECT_BLOCK_NEW, 1)
    P.write_text(text2, encoding="utf-8")
    print("monitor_server.py collect log error patch applied")


if __name__ == "__main__":
    apply()
