"""进行中采集：IPWO → Top100/tier live → Polymarket → 排名/赔率 → 独立写入 tennis:bundle:inplay。"""
from __future__ import annotations

import os
import time
from typing import Any

from tm.bundle import enrich_odds_for_events, enrich_rankings_from_events, fill_missing_birth_years, slim_event
from tm.bundle_store import INPLAY_BUNDLE_KEY, persist_live_collect
from tm.clients.polymarket import enrich_events_polymarket, get_request_count
from tm.clients.proxy import proxy_status_public
from tm.clients.sofascore import SofascoreClient
from tm.collectors.events import (
    collect_live_events_simple,
    collect_live_tennis_events,
    get_collect_stats,
    today_bj,
)
from tm.collectors.rankings import fetch_rank_board
from tm.collectors.tier_collect import (
    _STEP_LABELS,
    _STEPS,
    _TOP_N,
    attach_match_enrichment,
    build_request_stats,
    filter_top100_events,
    format_duration,
    log_step_done,
    log_tier_matches,
    log_timing_summary,
)
from tm.db.writer import collect_mysql_policy_message, log_collect_mysql_policy


_SIMPLE_LIMIT_DEFAULT = int(os.environ.get("SOFA_LIVE_SIMPLE_LIMIT", "20"))


def log_live_collect_header(*, filter_conditions: bool = False, top100: bool = True, simple_limit: int = _SIMPLE_LIMIT_DEFAULT) -> str:
    d = today_bj()
    print(f"=== 网球进行中采集 {d} ===")
    p = proxy_status_public()
    if p.get("enabled"):
        print(
            f"[1/{_STEPS}] IPWO 代理已就绪 "
            f"({p.get('mode')} {p.get('host')} zone={p.get('zone') or '-'})"
        )
    else:
        print(f"[1/{_STEPS}] 未配置 IPWO 代理，直连（建议在 monitor.env 配置 IPWO）")
    if not filter_conditions:
        print(f"[2/{_STEPS}] 进行中 · 前 {simple_limit} 场（无 tier/Top100 过滤）")
    elif top100:
        print(f"[2/{_STEPS}] 进行中 · 球员 Top100 + GS/500/1000")
    else:
        print(f"[2/{_STEPS}] 进行中 · GS/500/1000（不过滤 Top100）")
    print(f"      {collect_mysql_policy_message()}")
    return d


def run_tier_live_collect(
    *,
    filter_conditions: bool = False,
    top100: bool = True,
    simple_limit: int | None = None,
) -> dict[str, Any]:
    """采集进行中场次。

    filter_conditions=False：仅取进行中前 simple_limit 场，不做 tier/Top100 过滤。
    filter_conditions=True：tier + Top100（top100=False 时可用 --all 跳过 Top100）。
    """
    limit = simple_limit if simple_limit is not None else _SIMPLE_LIMIT_DEFAULT
    run_started = time.perf_counter()
    timing: dict[str, float] = {}
    d = log_live_collect_header(filter_conditions=filter_conditions, top100=top100, simple_limit=limit)
    if filter_conditions:
        log_collect_mysql_policy("tier_live" if not top100 else "top100_live")
    else:
        log_collect_mysql_policy("live_simple")

    prev_log = os.environ.get("SOFA_LOG_MATCHES")
    os.environ["SOFA_LOG_MATCHES"] = "0"
    client_stats: dict[str, int] = {}
    board: dict[str, Any] | None = None
    raw_events: list[dict] = []
    slim_events: list[dict] = []
    rankings_by_player: dict[str, dict[str, Any]] = {}
    birth_year_by_player: dict[str, int] = {}
    odds_by_event: dict[str, Any] = {}
    polymarket_by_event: dict[str, Any] = {}
    extra_rankings = 0
    odds_events = 0
    poly_requests_before = 0
    tier_before = 0
    try:
        with SofascoreClient() as client:
            t0 = time.perf_counter()
            client.warm_up()
            timing["step1"] = time.perf_counter() - t0
            log_step_done(1, _STEP_LABELS[0], timing["step1"])

            t0 = time.perf_counter()
            if filter_conditions and top100:
                board = fetch_rank_board(client, _TOP_N)
                atp_n = len(board.get("atp") or [])
                wta_n = len(board.get("wta") or [])
                print(f"      排名榜 ATP {atp_n} 人 · WTA {wta_n} 人")
            if filter_conditions:
                raw_events = collect_live_tennis_events(client)
                tier_before = len(raw_events)
                if top100 and board is not None:
                    raw_events = filter_top100_events(raw_events, board)
            else:
                raw_events = collect_live_events_simple(client, limit=limit)
                tier_before = len(raw_events)
            timing["step2"] = time.perf_counter() - t0
            log_step_done(2, _STEP_LABELS[1], timing["step2"])

            slim_events = [slim_event(ev) for ev in raw_events]
            if slim_events:
                if filter_conditions and top100 and tier_before != len(slim_events):
                    print(f"      Top100 过滤：{tier_before} → {len(slim_events)} 场")

                print(f"[3/{_STEPS}] Polymarket 比赛详情与赔率：{len(slim_events)} 场")
                t0 = time.perf_counter()
                poly_requests_before = get_request_count()
                polymarket_by_event = enrich_events_polymarket(slim_events)
                timing["step3"] = time.perf_counter() - t0
                log_step_done(3, _STEP_LABELS[2], timing["step3"])

                enrich_board = board
                if enrich_board is None:
                    enrich_board = fetch_rank_board(client, _TOP_N)
                    extra_rankings = 2
                print(f"[4/{_STEPS}] 球员排名与赔率：{len(slim_events)} 场")
                t0 = time.perf_counter()
                rankings_by_player = enrich_rankings_from_events(slim_events, enrich_board, client)
                birth_year_by_player = fill_missing_birth_years(client, slim_events)
                odds_by_event = enrich_odds_for_events(client, slim_events)
                odds_events = len(slim_events)
                for ev in slim_events:
                    attach_match_enrichment(
                        ev,
                        rankings_by_player,
                        odds_by_event,
                        polymarket_by_event,
                    )
                timing["step4"] = time.perf_counter() - t0
                log_step_done(4, _STEP_LABELS[3], timing["step4"])
                print(
                    f"      排名 {len(rankings_by_player)} 人 · "
                    f"年龄 {len(birth_year_by_player)} 人 · "
                    f"赔率 {len(odds_by_event)}/{len(slim_events)} · "
                    f"PM {len(polymarket_by_event)}/{len(slim_events)}"
                )
            else:
                timing["step3"] = 0.0
                timing["step4"] = 0.0

            client_stats = client.get_request_stats()
    finally:
        if prev_log is None:
            os.environ.pop("SOFA_LOG_MATCHES", None)
        else:
            os.environ["SOFA_LOG_MATCHES"] = prev_log

    collect_stats = get_collect_stats()
    poly_requests = max(0, get_request_count() - poly_requests_before)
    request_stats = build_request_stats(
        client_stats,
        top100=filter_conditions and top100,
        collect_stats=collect_stats,
        extra_rankings=extra_rankings,
        odds_events=odds_events,
        polymarket_events=len(polymarket_by_event),
        poly_requests=poly_requests,
    )
    t0 = time.perf_counter()
    log_tier_matches(
        slim_events,
        tier_before=tier_before if filter_conditions and top100 else None,
        top100=filter_conditions and top100,
        request_stats=request_stats,
    )
    timing["step5"] = time.perf_counter() - t0
    log_step_done(5, _STEP_LABELS[4], timing["step5"])

    collect_payload = {
        "ok": True,
        "date": d,
        "events": slim_events,
        "total_events": len(slim_events),
        "tier_before": tier_before,
        "rankingsByPlayer": rankings_by_player,
        "birthYearByPlayer": birth_year_by_player,
        "oddsByEvent": odds_by_event,
        "polymarketByEvent": polymarket_by_event,
        "stats": collect_stats,
        "requests": request_stats,
        "timing": timing,
        "top100": filter_conditions and top100,
        "top_rank_max": _TOP_N if filter_conditions and top100 else None,
        "filter_conditions": filter_conditions,
        "simple_limit": limit if not filter_conditions else None,
        "live_only": True,
    }
    print(f"[6/{_STEPS}] 写入 Redis（{INPLAY_BUNDLE_KEY} · collect_live）")
    t0 = time.perf_counter()
    persist_result = persist_live_collect(collect_payload)
    timing["step6"] = time.perf_counter() - t0
    log_step_done(6, _STEP_LABELS[5], timing["step6"])
    redis_info = persist_result.get("redis") or {}
    if redis_info.get("ok"):
        print(
            f"      bundle={persist_result.get('bundle_file')} · "
            f"redis {redis_info.get('key')} · "
            f"{persist_result.get('events')} 场 live"
        )
    elif redis_info.get("skipped"):
        print(f"      bundle={persist_result.get('bundle_file')} · redis 跳过: {redis_info.get('reason')}")
    else:
        print(f"      bundle={persist_result.get('bundle_file')} · redis 失败: {redis_info.get('error')}")

    total_sec = time.perf_counter() - run_started
    timing["total"] = total_sec
    collect_payload["timing"] = timing
    log_timing_summary(timing, total_sec)
    return {
        **collect_payload,
        "persist": persist_result,
    }
