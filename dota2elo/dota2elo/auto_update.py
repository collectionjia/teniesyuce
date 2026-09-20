"""自动更新管道：ingest → recalibrate → 状态报告。

调度器（launchd / cron）调用这个模块做完整的"刷新"操作。

典型用途：
- launchd plist 每 6h 跑一次
- cron 每天跑一次
- 手动 `python run.py auto-update`
"""
from __future__ import annotations
import json
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path

from .config import DB_PATH
from .db import session_scope
from .models import Team, Match, RatingHistory
from .ingest import full_ingest
from .calibration import recalibrate


UPDATE_LOG = DB_PATH.parent / "auto_update.log"
UPDATE_STATUS = DB_PATH.parent / "auto_update_status.json"


@dataclass
class UpdateStep:
    name: str
    started_at: str
    finished_at: str
    duration_sec: float
    success: bool
    message: str = ""


@dataclass
class UpdateResult:
    started_at: str
    finished_at: str
    total_duration_sec: float
    success: bool
    steps: list  # List[UpdateStep]
    n_teams_before: int = 0
    n_teams_after: int = 0
    n_matches_before: int = 0
    n_matches_after: int = 0
    new_matches: int = 0
    error: str = ""

    def to_dict(self):
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "total_duration_sec": round(self.total_duration_sec, 2),
            "success": self.success,
            "n_teams_before": self.n_teams_before,
            "n_teams_after": self.n_teams_after,
            "n_matches_before": self.n_matches_before,
            "n_matches_after": self.n_matches_after,
            "new_matches": self.new_matches,
            "error": self.error,
            "steps": [asdict(s) for s in self.steps],
        }


def _log(msg: str):
    """追加日志到 data/auto_update.log。"""
    line = f"[{datetime.now().isoformat()}] {msg}\n"
    UPDATE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(UPDATE_LOG, "a") as f:
        f.write(line)
    print(msg, flush=True)  # launchd/cron 也能看到


def _db_counts():
    """取当前 DB 计数。"""
    with session_scope() as s:
        n_teams = s.query(Team).count()
        n_matches = s.query(Match).count()
    return n_teams, n_matches


def _step(name: str, fn) -> UpdateStep:
    """执行一个步骤并记录耗时。"""
    started = datetime.now()
    _log(f"[step] {name} 开始...")
    try:
        result = fn()
        finished = datetime.now()
        msg = str(result) if result is not None else ""
        dur = (finished - started).total_seconds()
        _log(f"[step] {name} 完成 ({dur:.1f}s) {msg}")
        return UpdateStep(
            name=name, started_at=started.isoformat(), finished_at=finished.isoformat(),
            duration_sec=dur, success=True, message=msg,
        )
    except Exception as e:
        finished = datetime.now()
        dur = (finished - started).total_seconds()
        _log(f"[step] {name} 失败 ({dur:.1f}s): {e}")
        return UpdateStep(
            name=name, started_at=started.isoformat(), finished_at=finished.isoformat(),
            duration_sec=dur, success=False, message=str(e),
        )


def auto_update(
    source: str = "auto",
    max_pages: int = 5,
    recalibrate_after: bool = True,
    run_hc75: bool = False,  # 默认不开，因为 HC@75 跑得久
) -> UpdateResult:
    """完整更新管道。

    1. ingest（拉新比赛）
    2. recalibrate（重建校准表）
    3. （可选）跑 HC@75 验证

    Args:
        source: 数据源 (auto/opendota/stratz/multi)
        max_pages: ingest 拉取页数（每页约 100 场）
        recalibrate_after: 是否在 ingest 后重跑校准
        run_hc75: 是否跑 HC@75 验证（耗时较长，默认 False）
    """
    overall_start = datetime.now()
    _log("=" * 60)
    _log(f"自动更新开始 (source={source}, max_pages={max_pages})")

    n_teams_before, n_matches_before = _db_counts()
    steps = []
    success = True
    error = ""

    # Step 1: ingest
    def _do_ingest():
        result = full_ingest(source=source, max_pages=max_pages)
        return f"new_matches={result.get('new_matches', 0)}"

    s1 = _step("ingest", _do_ingest)
    steps.append(s1)
    if not s1.success:
        success = False
        error = s1.message
        _log(f"更新失败 (ingest 阶段): {error}")
        return _save_result(overall_start, steps, success, error,
                            n_teams_before, n_matches_before)

    # Step 2: recalibrate
    if recalibrate_after:
        def _do_recal():
            n = recalibrate()
            return f"calibration built on {n} matches"
        s2 = _step("recalibrate", _do_recal)
        steps.append(s2)
        if not s2.success:
            success = False
            error = s2.message
            _log(f"更新部分失败 (recalibrate 阶段): {error}")

    # Step 3 (可选): HC@75
    hc75_summary = ""
    if run_hc75:
        def _do_hc75():
            import subprocess
            import sys as _sys
            r = subprocess.run(
                [_sys.executable, "scripts/hc85_metric.py"],
                capture_output=True, text=True, timeout=120,
            )
            if r.returncode != 0:
                raise RuntimeError(f"hc85_metric.py failed: {r.stderr[:200]}")
            # 从 data/hc85_result.json 读结果
            import json as _json
            result_file = DB_PATH.parent / "hc85_result.json"
            if result_file.exists():
                with open(result_file) as f:
                    data = _json.load(f)
                return (f"HC@75 accuracy={data.get('accuracy', 0):.3f} "
                        f"n_qualified={data.get('n_qualified', 0)}")
            return "ok"
        s3 = _step("hc85", _do_hc75)
        steps.append(s3)
        if s3.success:
            try:
                hc75_summary = s3.message
            except Exception:
                pass

    n_teams_after, n_matches_after = _db_counts()
    new_matches = n_matches_after - n_matches_before

    overall_end = datetime.now()
    duration = (overall_end - overall_start).total_seconds()
    _log(f"自动更新完成 ({duration:.1f}s)  new_matches={new_matches}  "
         f"teams {n_teams_before}→{n_teams_after}  matches {n_matches_before}→{n_matches_after}")
    if hc75_summary:
        _log(f"  HC@75: {hc75_summary}")
    _log("=" * 60)

    return _save_result(
        overall_start, steps, success, error,
        n_teams_before, n_matches_before,
        n_teams_after, n_matches_after, new_matches,
    )


def _save_result(start_time, steps, success, error,
                 teams_before, matches_before,
                 teams_after=None, matches_after=None, new_matches=0):
    finished = datetime.now()
    duration = (finished - start_time).total_seconds()
    result = UpdateResult(
        started_at=start_time.isoformat(),
        finished_at=finished.isoformat(),
        total_duration_sec=duration,
        success=success,
        steps=steps,
        n_teams_before=teams_before,
        n_teams_after=teams_after or teams_before,
        n_matches_before=matches_before,
        n_matches_after=matches_after or matches_before,
        new_matches=new_matches,
        error=error,
    )
    # 写最新状态
    UPDATE_STATUS.parent.mkdir(parents=True, exist_ok=True)
    with open(UPDATE_STATUS, "w") as f:
        json.dump(result.to_dict(), f, indent=2, ensure_ascii=False)
    return result


def get_last_status() -> dict:
    """读最近一次的状态。"""
    if not UPDATE_STATUS.exists():
        return {"status": "never_run"}
    with open(UPDATE_STATUS) as f:
        return json.load(f)


def get_log_tail(n: int = 50) -> str:
    """读最近 n 行日志。"""
    if not UPDATE_LOG.exists():
        return "(no log)"
    with open(UPDATE_LOG) as f:
        lines = f.readlines()
    return "".join(lines[-n:])
