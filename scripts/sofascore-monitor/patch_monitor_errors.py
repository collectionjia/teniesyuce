"""Add friendly Chinese error messages to monitor_server.py."""
from __future__ import annotations

from pathlib import Path

P = Path("/home/ubuntu/sofascore-tennis-scraper/monitor_server.py")
text = P.read_text(encoding="utf-8")

HELPERS = '''

def _friendly_error(exc: Exception | str) -> str:
    msg = str(exc).strip()
    low = msg.lower()
    if "curl: (28)" in low or "connection timed out" in low or "timed out after" in low:
        return "Sofascore 请求超时（代理或网络响应慢），请稍后重试"
    if "curl: (7)" in low or "failed to connect" in low:
        return "无法连接 Sofascore/代理，请检查代理或网络"
    if "403 forbidden" in low or "api 403" in low:
        return "Sofascore 拒绝访问（403），请检查代理 IP 是否被封"
    if "collect already running" in low:
        return "已有采集任务在进行中，请稍后再试"
    if "live collect already running" in low:
        return "已有进行中比分拉取任务，请稍后再试"
    return msg


'''

TOP20_EXC_OLD = '                _top20_cache["error"] = str(exc)'
TOP20_EXC_NEW = '                _top20_cache["error"] = _friendly_error(exc)'

COLLECT_EXC_OLD = '                "error": str(exc),'
# Only replace in _run_collect finally block - need to be careful

LIVE_EXC_OLD = '''            _last_live.update({
                "status": "failed",
                "finished_at": _now(),
                "error": str(exc),
            })'''
LIVE_EXC_NEW = '''            _last_live.update({
                "status": "failed",
                "finished_at": _now(),
                "error": _friendly_error(exc),
            })'''

RUN_COLLECT_ERR_OLD = '''            _last_run.update({
                "status": "failed",
                "finished_at": _now(),
                "exit_code": -1,
                "error": str(exc),
            })'''
RUN_COLLECT_ERR_NEW = '''            _last_run.update({
                "status": "failed",
                "finished_at": _now(),
                "exit_code": -1,
                "error": _friendly_error(exc),
            })'''

COLLECT_FAIL_OLD = '''                "error": err,
            })'''
COLLECT_FAIL_NEW = '''                "error": _friendly_error(err) if err else None,
            })'''


def apply() -> None:
    text2 = text
    if "def _friendly_error" not in text2:
        anchor = "def _cron_lines() -> list[str]:"
        if "def _read_schedule_config" in text2:
            anchor = "def _read_schedule_config"
        text2 = text2.replace(anchor, HELPERS + "\n" + anchor, 1)
    text2 = text2.replace(TOP20_EXC_OLD, TOP20_EXC_NEW, 1)
    if LIVE_EXC_OLD in text2:
        text2 = text2.replace(LIVE_EXC_OLD, LIVE_EXC_NEW, 1)
    if RUN_COLLECT_ERR_OLD in text2:
        text2 = text2.replace(RUN_COLLECT_ERR_OLD, RUN_COLLECT_ERR_NEW, 1)
    if COLLECT_FAIL_OLD in text2:
        text2 = text2.replace(COLLECT_FAIL_OLD, COLLECT_FAIL_NEW, 1)
    P.write_text(text2, encoding="utf-8")
    print("monitor_server.py error messages patched")


if __name__ == "__main__":
    apply()
