"""后台任务管理：ingest、缓存清理等。"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from .db import session_scope
from .ingest import full_ingest
from .models import IngestJob
from .sources.cache import cache_stats, clear_cache

logger = logging.getLogger(__name__)

# 进程内任务状态镜像（DB 也有一份）
_jobs: Dict[str, Dict[str, Any]] = {}


def _now() -> datetime:
    return datetime.utcnow()


def list_jobs(limit: int = 20) -> list:
    """返回最近的任务（按 started_at 倒序）。"""
    with session_scope() as session:
        rows = session.query(IngestJob).order_by(IngestJob.started_at.desc().nulls_last()).limit(limit).all()
        return [
            {
                "id": j.id,
                "source": j.source,
                "max_pages": j.max_pages,
                "enrich_top_n": j.enrich_top_n,
                "status": j.status,
                "started_at": j.started_at.isoformat() if j.started_at else None,
                "finished_at": j.finished_at.isoformat() if j.finished_at else None,
                "result": json.loads(j.result) if j.result else None,
                "error": j.error,
            }
            for j in rows
        ]


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with session_scope() as session:
        j = session.get(IngestJob, job_id)
        if not j:
            return None
        return {
            "id": j.id,
            "source": j.source,
            "max_pages": j.max_pages,
            "enrich_top_n": j.enrich_top_n,
            "status": j.status,
            "started_at": j.started_at.isoformat() if j.started_at else None,
            "finished_at": j.finished_at.isoformat() if j.finished_at else None,
            "result": json.loads(j.result) if j.result else None,
            "error": j.error,
        }


def submit_ingest_job(source: str = "auto", max_pages: int = 20, enrich_top_n: int = 50) -> str:
    """同步启动一个 ingest 任务（在新线程里跑，不阻塞调用方）。"""
    job_id = uuid.uuid4().hex[:12]
    with session_scope() as session:
        session.add(IngestJob(
            id=job_id, source=source, max_pages=max_pages, enrich_top_n=enrich_top_n,
            status="pending", started_at=_now(),
        ))
    _jobs[job_id] = {"status": "pending", "started_at": _now()}

    def _runner():
        with session_scope() as session:
            j = session.get(IngestJob, job_id)
            j.status = "running"
        _jobs[job_id]["status"] = "running"
        try:
            stats = full_ingest(max_pages=max_pages, enrich_top_n=enrich_top_n, source=source)
            with session_scope() as session:
                j = session.get(IngestJob, job_id)
                j.status = "done"
                j.finished_at = _now()
                j.result = json.dumps(stats, default=str)
            _jobs[job_id].update({"status": "done", "result": stats})
        except Exception as e:  # noqa: BLE001
            import traceback
            tb = traceback.format_exc()
            logger.exception("ingest job %s 失败:\n%s", job_id, tb)
            with session_scope() as session:
                j = session.get(IngestJob, job_id)
                j.status = "error"
                j.finished_at = _now()
                j.error = tb[-2000:]  # 截断避免超长
            _jobs[job_id].update({"status": "error", "error": str(e)})

    import threading
    threading.Thread(target=_runner, daemon=True).start()
    return job_id
