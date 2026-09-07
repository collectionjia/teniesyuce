"""简化采集：IPWO → Top100/tier → Polymarket → Sofascore → 输出 → Redis。"""
from __future__ import annotations

import os
import time
from typing import Any

from tm.bundle import enrich_odds_for_events, enrich_rankings_from_events, slim_event
from tm.bundle_store import persist_collect_bundle
from tm.clients.polymarket import enrich_events_polymarket, format_polymarket_label, get_request_count
from tm.clients.proxy import proxy_status_public
from tm.clients.sofascore import SofascoreClient
from tm.collectors.events import collect_tennis_events, get_collect_stats, today_bj
from tm.collectors.rankings import event_matches_board, fetch_rank_board
from tm.db.writer import collect_mysql_policy_message, log_collect_mysql_policy
from tm.enrich import _event_tour

_TOP_N = int(os.environ.get("SOFA_TOP_N", "100"))
_STEPS = 6
_STEP_LABELS = (
    "代理预热",
    "Top100与赛事",
    "Polymarket",
    "排名与赔率",
    "结果输出",
    "写入Redis",
)


def format_duration(sec: float) -> str:
    if sec < 1:
        return f"{sec * 1000:.0f}ms"
    if sec < 60:
        return f"{sec:.1f}s"
    return f"{int(sec // 60)}m{sec % 60:.1f}s"


def log_step_done(step: int, label: str, elapsed_sec: float) -> None:
    print(f"      [{step}/{_STEPS}] {label} 完成 · 耗时 {format_duration(elapsed_sec)}")


def log_timing_summary(timing: dict[str, float], total_sec: float) -> None:
    parts = [f"{_STEP_LABELS[i - 1]} {format_duration(timing.get(f'step{i}', 0))}" for i in range(1, _STEPS + 1)]
    print(f"--- 耗时汇总 total={format_duration(total_sec)} | {' · '.join(parts)} ---")


def log_collect_header(*, match_date: str | None = None, top100: bool = True) -> str:
    d = match_date or today_bj()
    print(f"=== 网球采集 {d} ===")
    p = proxy_status_public()
    if p.get("enabled"):
        print(
            f"[1/{_STEPS}] IPWO 代理已就绪 "
            f"({p.get('mode')} {p.get('host')} zone={p.get('zone') or '-'})"
        )
    else:
        print(f"[1/{_STEPS}] 未配置 IPWO 代理，直连（建议在 monitor.env 配置 IPWO）")
    if top100:
        print(f"[2/{_STEPS}] 球员 Top100 + 赛事：ATP/WTA 各前 {_TOP_N} 名 · GS/500/1000")
    else:
        print(f"[2/{_STEPS}] 赛事：GS/500/1000（不过滤 Top100）")
    print(f"      {collect_mysql_policy_message()}")
    return d


def _rank_num(v: Any) -> str:
    if v is None:
        return "?"
    try:
        n = float(v)
        return str(int(n)) if n == int(n) else str(n)
    except (TypeError, ValueError):
        return str(v)


def format_player_rank(rankings: dict[str, dict[str, Any]], player: dict[str, Any]) -> str:
    pid = player.get("id")
    row = rankings.get(str(pid)) if pid is not None else None
    cur = (row or {}).get("current") or player.get("rank")
    prev = (row or {}).get("previous")
    best = (row or {}).get("best")
    if cur is None and prev is None and best is None:
        return "-"
    parts: list[str] = []
    if cur is not None:
        parts.append(f"#{_rank_num(cur)}")
    if prev is not None and prev != cur:
        parts.append(f"前#{_rank_num(prev)}")
    if best is not None:
        parts.append(f"最佳#{_rank_num(best)}")
    return " ".join(parts)


def format_match_odds(odds: dict[str, Any] | None) -> str | None:
    if not odds:
        return None
    ft = odds.get("full_time") or {}
    home = (ft.get("home") or {}).get("decimal")
    away = (ft.get("away") or {}).get("decimal")
    if home is None and away is None:
        return None
    return f"{home or '-'} / {away or '-'}"


def attach_match_enrichment(
    ev: dict[str, Any],
    rankings: dict[str, dict[str, Any]],
    odds_by_event: dict[str, Any],
    polymarket_by_event: dict[str, Any] | None = None,
) -> None:
    home_p = ev.get("homePlayer") or {}
    away_p = ev.get("awayPlayer") or {}
    ev["homeRankLabel"] = format_player_rank(rankings, home_p)
    ev["awayRankLabel"] = format_player_rank(rankings, away_p)
    by_player: dict[str, Any] = {}
    for side in (home_p, away_p):
        pid = side.get("id")
        if pid is not None:
            key = str(pid)
            row = rankings.get(key)
            if row:
                by_player[key] = row
    ev["rankings"] = by_player
    odds = odds_by_event.get(str(ev.get("id") or ""))
    if odds:
        ev["odds"] = odds
        ev["oddsLabel"] = format_match_odds(odds)
    poly = (polymarket_by_event or {}).get(str(ev.get("id") or ""))
    if poly:
        ev["polymarket"] = poly
        ev["polymarketLabel"] = format_polymarket_label(poly)


def log_tier_match(ev: dict) -> None:
    slim = ev if ev.get("homeRankLabel") is not None else slim_event(ev)
    tour = slim.get("tour") or "?"
    level = slim.get("level") or "?"
    tm_name = slim.get("tournamentShort") or slim.get("tournament") or "?"
    home = slim.get("home") or "?"
    away = slim.get("away") or "?"
    status = slim.get("status") or "?"
    start = slim.get("startTime") or "-"
    score = slim.get("scoreText") or ""
    score_part = f" [{score}]" if score else ""
    home_rank = slim.get("homeRankLabel")
    away_rank = slim.get("awayRankLabel")
    rank_part = ""
    if home_rank or away_rank:
        rank_part = f" | {home} {home_rank or '-'} vs {away} {away_rank or '-'}"
    odds_part = ""
    odds_label = slim.get("oddsLabel")
    if odds_label:
        odds_part = f" | 赔 {odds_label}"
    poly_part = ""
    poly = slim.get("polymarket") or {}
    poly_label = slim.get("polymarketLabel")
    if poly_label:
        poly_part = f" | PM {poly_label}"
    elif poly.get("url"):
        poly_part = f" | PM {poly.get('url')}"
    print(
        f"      · {tour} {level} | {tm_name} | {home} vs {away} | "
        f"{status} {start}{score_part}{rank_part}{poly_part}{odds_part}"
    )


def build_request_stats(
    client_stats: dict[str, int],
    *,
    top100: bool = False,
    collect_stats: dict[str, Any] | None = None,
    extra_rankings: int = 0,
    odds_events: int = 0,
    polymarket_events: int = 0,
    poly_requests: int = 0,
) -> dict[str, Any]:
    cs = collect_stats or get_collect_stats()
    req = dict(cs.get("requests") or {})
    rankings = (2 if top100 else 0) + extra_rankings
    return {
        "http_total": client_stats.get("total", 0),
        "http_api": client_stats.get("api", 0),
        "http_warmup": client_stats.get("warmup", 0),
        "http_retries": client_stats.get("retries", 0),
        "rankings": rankings,
        "live": req.get("live", 1),
        "scheduled_pages": req.get("scheduled_pages", 0),
        "tier_detail": req.get("tier_detail", 0),
        "tier_detail_tournaments": cs.get("tier_detail_fetched", 0),
        "odds": odds_events,
        "polymarket": polymarket_events,
        "poly_requests": poly_requests,
    }


def log_tier_matches(
    events: list[dict],
    *,
    tier_before: int | None = None,
    top100: bool = False,
    request_stats: dict[str, Any] | None = None,
) -> None:
    if not events:
        print(f"[{_STEPS}/{_STEPS}] 无符合条件的比赛")
        if request_stats:
            print(
                f"--- 请求 total={request_stats.get('http_total')} "
                f"(warmup={request_stats.get('http_warmup')} api={request_stats.get('http_api')}) ---"
            )
        return
    label = f"[{_STEPS}/{_STEPS}]"
    if top100 and tier_before is not None and tier_before != len(events):
        print(f"{label} Top100 过滤：{tier_before} → {len(events)} 场")
    else:
        print(f"{label} 共 {len(events)} 场：")
    for ev in sorted(events, key=lambda e: (e.get("startTimestamp") or 0, e.get("id") or 0)):
        log_tier_match(ev)
    atp = sum(1 for ev in events if (ev.get("tour") or _event_tour(ev)) == "ATP")
    wta = sum(1 for ev in events if (ev.get("tour") or _event_tour(ev)) == "WTA")
    live = sum(
        1
        for ev in events
        if str(ev.get("statusType") or "").lower() not in {"finished", "canceled", "cancelled"}
        and str(ev.get("statusType") or "").lower() in {"inprogress", "live", "interrupted"}
    )
    stats = get_collect_stats()
    print(
        f"--- 汇总 tournaments={stats.get('tier')} tier_kept={tier_before or stats.get('kept_events')} "
        f"top100_kept={len(events)} live={live} ATP={atp} WTA={wta} ---"
    )
    if request_stats:
        print(
            f"--- 请求 total={request_stats.get('http_total')} "
            f"(warmup={request_stats.get('http_warmup')} api={request_stats.get('http_api')} "
            f"retries={request_stats.get('http_retries')}) ---"
        )
        print(
            f"      构成: 排名={request_stats.get('rankings')} live={request_stats.get('live')} "
            f"赛程页={request_stats.get('scheduled_pages')} "
            f"签表={request_stats.get('tier_detail')}({request_stats.get('tier_detail_tournaments')}站×2) "
            f"poly={request_stats.get('polymarket', 0)}({request_stats.get('poly_requests', 0)}req) "
            f"赔率={request_stats.get('odds', 0)}"
        )


def filter_top100_events(raw_events: list[dict], board: dict[str, Any]) -> list[dict]:
    return [ev for ev in raw_events if event_matches_board(ev, board)]


def run_tier_collect(*, match_date: str | None = None, top100: bool = True) -> dict[str, Any]:
    """一步采集并打印日志；top100=True 时仅保留双方至少一人在 Top100 的对阵。"""
    run_started = time.perf_counter()
    timing: dict[str, float] = {}
    d = log_collect_header(match_date=match_date, top100=top100)
    log_collect_mysql_policy("tier" if not top100 else "top100")

    prev_log = os.environ.get("SOFA_LOG_MATCHES")
    os.environ["SOFA_LOG_MATCHES"] = "0"
    client_stats: dict[str, int] = {}
    board: dict[str, Any] | None = None
    raw_events: list[dict] = []
    slim_events: list[dict] = []
    rankings_by_player: dict[str, dict[str, Any]] = {}
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
            if top100:
                board = fetch_rank_board(client, _TOP_N)
                atp_n = len(board.get("atp") or [])
                wta_n = len(board.get("wta") or [])
                print(f"      排名榜 ATP {atp_n} 人 · WTA {wta_n} 人")
            raw_events = collect_tennis_events(client, d)
            tier_before = len(raw_events)
            if top100 and board is not None:
                raw_events = filter_top100_events(raw_events, board)
            timing["step2"] = time.perf_counter() - t0
            log_step_done(2, _STEP_LABELS[1], timing["step2"])

            slim_events = [slim_event(ev) for ev in raw_events]
            if slim_events:
                if top100 and tier_before != len(slim_events):
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
                print(
                    f"[4/{_STEPS}] 球员排名与赔率：{len(slim_events)} 场"
                )
                t0 = time.perf_counter()
                rankings_by_player = enrich_rankings_from_events(slim_events, enrich_board)
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
        top100=top100,
        collect_stats=collect_stats,
        extra_rankings=extra_rankings,
        odds_events=odds_events,
        polymarket_events=len(polymarket_by_event),
        poly_requests=poly_requests,
    )
    t0 = time.perf_counter()
    log_tier_matches(
        slim_events,
        tier_before=tier_before if top100 else None,
        top100=top100,
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
        "oddsByEvent": odds_by_event,
        "polymarketByEvent": polymarket_by_event,
        "stats": collect_stats,
        "requests": request_stats,
        "timing": timing,
        "top100": top100,
        "top_rank_max": _TOP_N if top100 else None,
    }
    print(f"[6/{_STEPS}] 写入 Redis（bundle + tennis:bundle:full）")
    t0 = time.perf_counter()
    persist_result = persist_collect_bundle(collect_payload)
    timing["step6"] = time.perf_counter() - t0
    log_step_done(6, _STEP_LABELS[5], timing["step6"])
    redis_info = persist_result.get("redis") or {}
    if redis_info.get("ok"):
        print(
            f"      bundle={persist_result.get('bundle_file')} · "
            f"redis {redis_info.get('key')} · {redis_info.get('events')} 场"
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
