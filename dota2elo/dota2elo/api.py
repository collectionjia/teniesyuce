"""FastAPI 应用：REST API + 服务端渲染的前端。

## 概览

启动后访问：
- http://127.0.0.1:3001/        —— 战队排行榜页面
- http://127.0.0.1:3001/predict  —— 胜率预测页面
- http://127.0.0.1:3001/team/{id}—— 单队详情 + Elo 趋势
- http://127.0.0.1:3001/admin    —— 管理后台（触发 ingest / 看任务）
- http://127.0.0.1:3001/docs     —— Swagger UI（自动生成）
- http://127.0.0.1:3001/redoc    —— ReDoc（自动生成）
- http://127.0.0.1:3001/openapi.json —— OpenAPI 3.1 规范

详细 API 说明见 `API.md`。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from starlette.requests import Request

from . import ingest, jobs
from . import __version__
from .db import init_db, session_scope
from .elo import expected_win, HIGH_CONFIDENCE_THRESHOLD, is_high_confidence, predict, upset_adjusted_prob, upset_risk_points as calc_risk_points, k_factor, meets_winrate_75_conditions, meets_winrate_80_conditions, TeamRating
from .sources.cache import cache_stats, clear_cache

logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
TEMPLATES_DIR = WEB_DIR / "templates"
STATIC_DIR = WEB_DIR / "static"

OPENAPI_TAGS = [
    {
        "name": "页面",
        "description": "服务端渲染的 HTML 页面（浏览器访问）",
    },
    {
        "name": "查询",
        "description": "公开查询接口（战队 / 比赛 / 预测）",
    },
    {
        "name": "管理",
        "description": "数据更新和维护接口（建议加鉴权）",
    },
]

app = FastAPI(
    title="Dota2 Elo",
    description=(
        "全球 Dota2 战队 Elo 评分 + 胜率预测系统。\n\n"
        "**数据源**：OpenDota / Stratz（多源 fallback） + dota-pro-db 预构建数据集。\n\n"
        "**算法**：标准 Elo + 按联赛级别分级的 K 因子（TI=60, Major=50, DPC=40, ...）。\n\n"
        "**前端**：Jinja2 服务端渲染 + Chart.js 趋势图。\n\n"
        "详细说明见 [API.md](https://github.com/yourname/dota2elo/blob/main/API.md)。"
    ),
    version=__version__,
    openapi_tags=OPENAPI_TAGS,
    contact={"name": "Dota2 Elo"},
    license_info={"name": "MIT"},
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.on_event("startup")
def _startup() -> None:
    init_db()


# ============================== 页面 ============================== #
@app.get("/", response_class=HTMLResponse, tags=["页面"], summary="排行榜首页")
def page_rankings(request: Request):
    """战队 Elo 排行榜页面（按 Elo 降序）。"""
    return templates.TemplateResponse("rankings.html", {"request": request})


@app.get("/predict", response_class=HTMLResponse, tags=["页面"], summary="胜率预测页面")
def page_predict(request: Request):
    """两支战队胜率预测页面。"""
    return templates.TemplateResponse("predict.html", {"request": request})


@app.get("/team/{team_id}", response_class=HTMLResponse, tags=["页面"], summary="战队详情页")
def page_team(request: Request, team_id: int):
    """单队详情：当前 Elo、最近比赛、完整 Elo 历史趋势。"""
    return templates.TemplateResponse("team.html", {"request": request, "team_id": team_id})


@app.get("/admin", response_class=HTMLResponse, tags=["页面"], summary="管理后台")
def page_admin(request: Request):
    """管理后台：触发数据更新、查看任务状态、清理缓存。"""
    return templates.TemplateResponse("admin.html", {"request": request})


# ============================== 查询 ============================== #
@app.get(
    "/api/health",
    tags=["查询"],
    summary="健康检查",
    description="最简健康检查。任何时候都可以用，无副作用。",
)
def health():
    """健康检查。"""
    return {"ok": True, "version": __version__}


@app.get(
    "/api/rankings",
    tags=["查询"],
    summary="战队排行榜",
    description="按当前 Elo 降序返回战队列表。包含战绩、胜率、最后比赛时间。",
)
def api_rankings(limit: int = Query(100, ge=1, le=500, description="最多返回多少支队伍")):
    """战队排行榜（按 Elo 降序）。"""
    return ingest.rankings(limit=limit)


@app.get(
    "/api/teams",
    tags=["查询"],
    summary="按名称模糊搜索战队",
    description="用 name/tag/id 模糊匹配，返回最多 20 支匹配队伍，按 rating 降序。",
)
def api_search_teams(
    q: str = Query(..., min_length=1, description="搜索关键字（匹配 name/tag/id）"),
):
    """搜索战队。"""
    return ingest.find_team(q)


@app.get(
    "/api/teams/{team_id}",
    tags=["查询"],
    summary="战队详情 + Elo 历史",
    description=(
        "返回战队当前信息和完整 Elo 历史（每场比赛一条记录）。"
        "Elo 历史是绘制趋势图的数据源。"
    ),
    responses={
        200: {"description": "成功"},
        404: {"description": "战队不存在"},
    },
)
def api_team_detail(team_id: int):
    """单队详情 + 完整 Elo 历史。"""
    from .db import session_scope
    from .models import Team
    with session_scope() as session:
        t = session.get(Team, team_id)
        if not t:
            raise HTTPException(404, f"Team {team_id} not found")
        detail = {
            "id": t.id,
            "name": t.name,
            "tag": t.tag,
            "logo_url": t.logo_url,
            "rating": round(t.rating, 1),
            "matches_played": t.matches_played,
            "wins": t.wins,
            "losses": t.losses,
            "win_rate": round(t.wins / t.matches_played, 4) if t.matches_played else 0.0,
            "last_match_at": t.last_match_at.isoformat() if t.last_match_at else None,
        }
    history = ingest.team_history(team_id, limit=10_000)
    return {"team": detail, "history": history}


@app.get(
    "/api/predict",
    tags=["查询"],
    summary="两队胜率预测（融合版）",
    description=(
        "基于 Elo 的胜率预测，返回：\n"
        "- `p_a_win` / `p_b_win`：基础 Elo 胜率\n"
        "- `composite_*`：4 维复合评分（team+player+hero+patch 加权）\n"
        "- `upset_adjusted_prob`：扣 5 维 upset risk 后的实战胜率\n"
        "- `is_high_confidence`：是否满足 5 条高置信条件\n"
        "- `risk_points`：upset risk 总分（0~115）\n\n"
        "可调参数：`upset_risk_points` 手动加 risk；`series_type` 0/1/2 影响 K 因子"
    ),
    responses={
        200: {"description": "预测成功"},
        404: {"description": "至少一方战队不存在"},
    },
)
def api_predict(
    a: int = Query(..., description="战队 A 的 ID"),
    b: int = Query(..., description="战队 B 的 ID"),
    series_type: Optional[int] = Query(None, description="比赛系列类型 0=BO1 1=BO3 2=BO5"),
    new_patch_week: bool = Query(False, description="是否新版本第一周"),
    favorite_roster_change: bool = Query(False, description="热门方换人"),
    favorite_hidden_pool: bool = Query(False, description="热门方有隐藏池"),
    underdog_win_streak: bool = Query(False, description="弱方近期连胜"),
    upset_risk_points: int = Query(0, ge=0, le=200, description="手动加 upset risk（0=自动）"),
):
    """两队胜负预测（融合版）。"""
    from .elo import (
        TeamRating, predict, is_high_confidence,
        upset_risk_points as calc_risk, upset_adjusted_prob, k_factor,
    )

    # 拉两个 team 的当前 rating + per-tier Elo
    with session_scope() as session:
        from .models import Team
        ta = session.get(Team, a)
        tb = session.get(Team, b)
        if not ta or not tb:
            raise HTTPException(404, "One or both teams not found")
        a_rating, a_name, a_games = ta.rating, ta.name, ta.matches_played
        b_rating, b_name, b_games = tb.rating, tb.name, tb.matches_played
        # v1.6: 4 套 per-tier Elo
        a_elo_t = {1: ta.elo_t1, 2: ta.elo_t2, 3: ta.elo_t3, 4: ta.elo_t4}
        a_games_t = {1: ta.games_t1, 2: ta.games_t2, 3: ta.games_t3, 4: ta.games_t4}
        b_elo_t = {1: tb.elo_t1, 2: tb.elo_t2, 3: tb.elo_t3, 4: tb.elo_t4}
        b_games_t = {1: tb.games_t1, 2: tb.games_t2, 3: tb.games_t3, 4: tb.games_t4}

    # 基础 Elo 预测（向后兼容）
    basic = ingest.predict_match(a, b)
    p_basic_a = basic.get("p_a_win", 0.5)
    p_basic_b = basic.get("p_b_win", 0.5)

    # v1.5/v1.6: 取 tier（基于两队最近联赛），需要先于 predict()
    from .models import Match
    from .league_tiers import get_tier, tier_warning, TIER_NAMES
    with session_scope() as session:
        last_a_row = session.execute(
            select(Match.league_name, Match.league_id)
            .where(Match.radiant_team_id == a)
            .order_by(Match.start_time.desc().nulls_last())
            .limit(1)
        ).first()
        last_b_row = session.execute(
            select(Match.league_name, Match.league_id)
            .where(Match.radiant_team_id == b)
            .order_by(Match.start_time.desc().nulls_last())
            .limit(1)
        ).first()
        last_league = last_a_row[0] if last_a_row else None
        last_league_id = last_a_row[1] if last_a_row else None
        last_league_b = last_b_row[0] if last_b_row else None
        last_league_b_id = last_b_row[1] if last_b_row else None
    tier_a = get_tier(league_id=last_league_id, league_name=last_league)
    tier_b = get_tier(league_id=last_league_b_id, league_name=last_league_b)
    gap_warning = tier_warning(tier_a, tier_b)
    # v1.6: per-tier Elo 选择（A 用自己 tier 的 Elo，反映"A 在自己常玩联赛的真实水平"）
    tier_elo_a = a_elo_t.get(tier_a, 1500.0)
    tier_elo_b = b_elo_t.get(tier_b, 1500.0)
    tier_games_a = a_games_t.get(tier_a, 0)
    tier_games_b = b_games_t.get(tier_b, 0)

    # 4 维复合评分（v1.3 接 player_elo 真实数据，v1.5 Bayesian 收缩 + tier 偏移）
    from .roster import get_current_roster, get_team_recent_players_with_names
    roster_a = get_current_roster(a)
    roster_b = get_current_roster(b)
    # v1.5: 选手 matches 字典（用于收缩）
    players_a_full = get_team_recent_players_with_names(a)
    players_b_full = get_team_recent_players_with_names(b)
    matches_a = {pid: m for (pid, _, _, m) in players_a_full}
    matches_b = {pid: m for (pid, _, _, m) in players_b_full}
    team_a = TeamRating(
        team_id=a, name=a_name, team_elo=a_rating, games=a_games,
        player_elo=roster_a, player_matches=matches_a,
    )
    team_b = TeamRating(
        team_id=b, name=b_name, team_elo=b_rating, games=b_games,
        player_elo=roster_b, player_matches=matches_b,
    )
    p_composite, diff_composite = predict(
        team_a, team_b,
        tier_a=tier_a, tier_b=tier_b,
        tier_elo_a=tier_elo_a, tier_elo_b=tier_elo_b,
        tier_games_a=tier_games_a, tier_games_b=tier_games_b,
    )

    # 取最近 5 场常用选手详情（v1.3 新增）
    players_a = get_team_recent_players_with_names(a)
    players_b = get_team_recent_players_with_names(b)

    # Upset risk 计算
    is_fav = p_composite >= 0.5
    auto_risk = calc_risk(
        favorite_is_favorite=is_fav,
        series_type=series_type,
        new_patch_week=new_patch_week,
        favorite_roster_change=favorite_roster_change,
        favorite_hidden_pool=favorite_hidden_pool,
        underdog_win_streak=underdog_win_streak,
    )
    risk = max(auto_risk, upset_risk_points)
    p_adjusted = upset_adjusted_prob(team_a, team_b, risk_points=risk)

    # 高置信过滤
    is_hc = is_high_confidence(
        team_a, team_b,
        series_type=series_type,
        draft_adv_a=0.0, draft_adv_b=0.0,
    )

    # 75% 实战胜率条件（数据驱动）
    wr75 = meets_winrate_75_conditions(
        team_a, team_b,
        series_type=series_type,
    )

    # 80% 高置信度过滤（v1.3）
    wr80 = meets_winrate_80_conditions(
        team_a, team_b,
        series_type=series_type,
    )

    # K 因子（按 series_type + league 联合）
    # last_league 已在上面 v1.5 tier 查询中拿到
    k = k_factor(series_type=series_type, league_name=last_league)

    # Elo 差驱动的概率校准（基于历史实战胜率，v1.7 tier-aware）
    from .calibration import get_calibration
    cal = get_calibration()
    elo_diff_abs = abs(a_rating - b_rating)
    # v1.7: 跨层比赛时把 calibrated 胜率向 50% 拉（保守）
    cross_tier_gap = abs((tier_a or 3) - (tier_b or 3)) if (tier_a and tier_b) else 0
    p_calibrated = cal.apply(elo_diff_abs, tier_gap=cross_tier_gap)
    # 强队是 a 还是 b？
    if a_rating >= b_rating:
        p_a_calibrated = p_calibrated
        p_b_calibrated = 1.0 - p_calibrated
    else:
        p_a_calibrated = 1.0 - p_calibrated
        p_b_calibrated = p_calibrated

    return {
        # 基础字段（向后兼容）
        "team_a_id": a,
        "team_a_name": a_name,
        "team_a_rating": round(a_rating, 1),
        "team_b_id": b,
        "team_b_name": b_name,
        "team_b_rating": round(b_rating, 1),
        "p_a_win": p_basic_a,
        "p_b_win": p_basic_b,
        # 融合版新增
        "composite_p_a_win": round(p_composite, 4),
        "composite_p_b_win": round(1 - p_composite, 4),
        "composite_elo_diff": round(diff_composite, 1),
        "upset_adjusted_prob": round(p_adjusted, 4),
        "is_high_confidence": is_hc,
        "risk_points": risk,
        "risk_breakdown": {
            "new_patch_week": new_patch_week,
            "favorite_roster_change": favorite_roster_change,
            "favorite_hidden_pool": favorite_hidden_pool,
            "bo1": series_type == 0,
            "underdog_win_streak": underdog_win_streak,
            "manual_extra": upset_risk_points,
        },
        "k_factor": round(k, 1),
        "last_league": last_league,
        # v1.5 联赛层级警告（Elo 跨层级比赛会失真）
        "team_a_tier": TIER_NAMES.get(tier_a, f"T{tier_a}"),
        "team_b_tier": TIER_NAMES.get(tier_b, f"T{tier_b}"),
        "tier_gap_warning": gap_warning,
        # v1.6 per-tier Elo（按自己 tier 取，反映"在该 tier 联赛的真实水平"）
        "team_a_tier_elo": round(tier_elo_a, 1),
        "team_b_tier_elo": round(tier_elo_b, 1),
        "team_a_tier_games": tier_games_a,
        "team_b_tier_games": tier_games_b,
        # Elo 校准（基于历史实战数据，不用 logistic 公式）
        "calibrated_p_a_win": round(p_a_calibrated, 4),
        "calibrated_p_b_win": round(p_b_calibrated, 4),
        "elo_diff": round(elo_diff_abs, 1),
        # v1.3 选手数据
        "team_a_roster": [
            {"id": pid, "name": name, "elo": round(elo, 1), "matches": cnt}
            for (pid, name, elo, cnt) in players_a
        ],
        "team_b_roster": [
            {"id": pid, "name": name, "elo": round(elo, 1), "matches": cnt}
            for (pid, name, elo, cnt) in players_b
        ],
        "roster_avg_elo_a": round(sum(elo for _, _, elo, _ in players_a) / max(1, len(players_a)), 1),
        "roster_avg_elo_b": round(sum(elo for _, _, elo, _ in players_b) / max(1, len(players_b)), 1),
        # 75% 实战胜率条件（数据驱动）
        "meets_75_condition": wr75.meets,
        "winrate_75_conditions": wr75.met_conditions,
        "winrate_75_best_signal": wr75.best_signal,
        "winrate_75_expected": round(wr75.expected_winrate, 4),
        # 80% 高置信度过滤（v1.3）
        "meets_80_condition": wr80.meets,
        "winrate_80_conditions": wr80.met_conditions,
        "winrate_80_best_signal": wr80.best_signal,
        "winrate_80_expected": round(wr80.expected_winrate, 4),
        "rejected_75_conditions": wr80.rejected_75_conditions,
    }


@app.get(
    "/api/matches",
    tags=["查询"],
    summary="最近的职业比赛",
    description="按时间倒序返回最近的比赛，含双方队名、比分、K 因子。",
)
def api_matches(limit: int = Query(50, ge=1, le=200, description="最多返回多少场")):
    """最近的职业比赛。"""
    return ingest.recent_matches(limit=limit)


# ============================== 管理 ============================== #
@app.post(
    "/api/admin/recompute",
    tags=["管理"],
    summary="全量重算 Elo（同步）",
    description=(
        "清空所有 rating_history 并按时间顺序重放所有比赛，重算每个队的 Elo。"
        "**同步执行**，2000 场约 1-2 秒，10 万场约 1 分钟。"
    ),
)
def api_recompute():
    """全量重算 Elo。"""
    stats = ingest.recompute_all_ratings()
    return stats


@app.post(
    "/api/admin/ingest",
    tags=["管理"],
    summary="启动后台 ingest 任务",
    description=(
        "异步启动一个数据更新任务（拉比赛 + 补全战队元数据 + 重算 Elo），"
        "立即返回 job_id，**不会阻塞**。用 `/api/admin/jobs/{id}` 查进度。"
    ),
    responses={
        200: {"description": "任务已创建"},
        400: {"description": "参数非法或缺少 STRATZ_API_KEY"},
    },
)
def api_ingest(
    source: str = Query(
        "auto",
        description="数据源：auto / opendota / stratz / multi",
    ),
    max_pages: int = Query(20, ge=1, le=200, description="拉取页数（每页 100 场）"),
    enrich_top_n: int = Query(50, ge=0, le=500, description="补全元数据的战队数"),
):
    """启动后台 ingest 任务。"""
    if source not in ("auto", "opendota", "stratz", "multi"):
        raise HTTPException(400, f"source 取值非法: {source}")
    if source in ("stratz", "multi"):
        import os
        if not os.getenv("STRATZ_API_KEY"):
            raise HTTPException(400, f"source={source} 需要设置 STRATZ_API_KEY")
    job_id = jobs.submit_ingest_job(source=source, max_pages=max_pages, enrich_top_n=enrich_top_n)
    return {"job_id": job_id, "status": "pending"}


@app.get(
    "/api/admin/jobs",
    tags=["管理"],
    summary="最近任务列表",
)
def api_jobs(limit: int = Query(20, ge=1, le=100, description="最多返回多少个任务")):
    """最近任务列表。"""
    return jobs.list_jobs(limit=limit)


@app.get(
    "/api/admin/jobs/{job_id}",
    tags=["管理"],
    summary="单任务详情",
    description="返回任务状态（pending/running/done/error）、开始/结束时间、结果、错误信息。",
    responses={
        200: {"description": "成功"},
        404: {"description": "任务不存在"},
    },
)
def api_job_detail(job_id: str):
    """单任务详情。"""
    j = jobs.get_job(job_id)
    if not j:
        raise HTTPException(404, f"Job {job_id} not found")
    return j


@app.get(
    "/api/admin/cache/stats",
    tags=["管理"],
    summary="数据源缓存统计",
    description="缓存条目数 + 已过期条目数。",
)
def api_cache_stats():
    """缓存统计。"""
    return cache_stats()


@app.post(
    "/api/admin/cache/clear",
    tags=["管理"],
    summary="清空数据源缓存",
    description="清空所有已缓存的 match/team 元数据。下次请求会重新拉远端。",
)
def api_cache_clear():
    """清空缓存。"""
    n = clear_cache()
    return {"cleared": n}


@app.get(
    "/api/players",
    tags=["查询"],
    summary="选手排行（v1.3 4 维数据）",
    description=(
        "按 player Elo 排序的选手榜。Elo 基于回填比赛数据计算。\n"
        "需要先跑 `python scripts/backfill_players.py --limit N` 才有数据。\n"
        "- `min_matches`: 最少比赛数过滤（避免样本不足）"
    ),
)
def api_players(
    limit: int = Query(50, ge=1, le=500),
    min_matches: int = Query(5, ge=1, le=100, description="最少比赛数"),
):
    """选手榜。"""
    from .models import Player
    with session_scope() as s:
        players = s.query(Player).filter(
            Player.matches_played >= min_matches
        ).order_by(Player.current_elo.desc()).limit(limit).all()
        return {
            "n_total": s.query(Player).count(),
            "n_qualified": len(players),
            "min_matches": min_matches,
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "elo": round(p.current_elo, 1),
                    "matches": p.matches_played,
                    "wins": p.wins,
                    "losses": p.losses,
                    "win_rate": round(p.wins / p.matches_played, 4) if p.matches_played else 0,
                }
                for p in players
            ],
        }


@app.get(
    "/api/players/{player_id}",
    tags=["查询"],
    summary="选手详情",
    description="单个选手的 Elo、最近比赛数、胜率。",
)
def api_player_detail(player_id: int):
    """选手详情。"""
    from .models import Player, PlayerMatchStat
    with session_scope() as s:
        p = s.get(Player, player_id)
        if not p:
            return {"error": "not found", "player_id": player_id}
        recent = s.query(PlayerMatchStat).filter(
            PlayerMatchStat.player_id == player_id
        ).order_by(PlayerMatchStat.match_id.desc()).limit(20).all()
        return {
            "id": p.id,
            "name": p.name,
            "elo": round(p.current_elo, 1),
            "matches": p.matches_played,
            "wins": p.wins,
            "losses": p.losses,
            "win_rate": round(p.wins / p.matches_played, 4) if p.matches_played else 0,
            "last_seen_at": p.last_seen_at.isoformat() if p.last_seen_at else None,
            "recent_match_count": len(recent),
        }


@app.get(
    "/api/backtest",
    tags=["查询"],
    summary="Elo 模型回测（log loss / Brier / reliability）",
    description=(
        "用历史比赛的赛前 Elo 评估模型校准度：\n"
        "- `log_loss`：交叉熵，越小越好\n"
        "- `brier`：Brier 分数（= MSE），越小越好\n"
        "- `reliability`：分桶（每 5%）预测胜率 vs 实际胜率\n"
        "- `high_confidence_rate`：高置信场次的实际胜率\n"
        "可设 `min_games` 过滤老战队。"
    ),
)
def api_backtest(min_games: int = Query(10, ge=0, le=200, description="双方最小比赛数过滤")):
    """Elo 模型回测。"""
    import math
    from collections import defaultdict
    from .elo import expected_win, HIGH_CONFIDENCE_THRESHOLD

    preds, actuals = [], []
    bins = defaultdict(list)
    hc_actuals = []
    reliability = []
    n = 0
    with session_scope() as session:
        from .models import Match, RatingHistory
        # 拿出所有比赛（双方都有 history 的）
        matches = session.scalars(
            select(Match)
            .where(Match.radiant_team_id.is_not(None), Match.dire_team_id.is_not(None))
            .order_by(Match.start_time.asc().nulls_last())
        ).all()
        for m in matches:
            r = session.scalar(select(RatingHistory).where(
                RatingHistory.match_id == m.match_id, RatingHistory.team_id == m.radiant_team_id))
            d = session.scalar(select(RatingHistory).where(
                RatingHistory.match_id == m.match_id, RatingHistory.team_id == m.dire_team_id))
            if not r or not d:
                continue
            n += 1
            p = expected_win(r.elo_before, d.elo_before)
            actual = 1.0 if m.radiant_win else 0.0
            preds.append(p)
            actuals.append(actual)
            b = round(p * 20) / 20.0
            bins[b].append(actual)
            if max(p, 1 - p) >= HIGH_CONFIDENCE_THRESHOLD:
                hc_actuals.append(actual if p >= 0.5 else 1 - actual)

    if not preds:
        return {"n": 0, "message": "没有足够的比赛历史"}

    # log loss
    log_loss = -sum(
        a * math.log(max(p, 1e-6)) + (1 - a) * math.log(max(1 - p, 1e-6))
        for p, a in zip(preds, actuals)
    ) / len(preds)
    brier = sum((p - a) ** 2 for p, a in zip(preds, actuals)) / len(preds)
    for b in sorted(bins):
        v = bins[b]
        if v:
            reliability.append({
                "bucket": round(b, 2),
                "count": len(v),
                "actual_winrate": round(sum(v) / len(v), 4),
            })
    return {
        "n": len(preds),
        "log_loss": round(log_loss, 4),
        "brier": round(brier, 4),
        "high_confidence_count": len(hc_actuals),
        "high_confidence_rate": round(sum(hc_actuals) / len(hc_actuals), 4) if hc_actuals else None,
        "reliability": reliability,
    }


@app.get(
    "/api/calibration",
    tags=["查询"],
    summary="Elo 差 → 实际胜率校准表",
    description=(
        "返回从历史比赛学到的 `(Elo 差, 实际胜率)` 映射表。\n"
        "- 桶宽 50 Elo\n"
        "- 平滑窗口 ±3 桶（带样本量加权）\n"
        "- 缺数据桶使用 logistic 期望值\n"
        "校准表文件：`data/calibration.json`\n"
        "重跑校准：`POST /api/admin/recalibrate` 或 `python run.py recalibrate`"
    ),
)
def api_calibration():
    """Elo 差 → 实际胜率校准表。"""
    from .calibration import get_calibration
    cal = get_calibration()
    if not cal.buckets:
        return {
            "loaded": False,
            "message": "校准表未构建，请先调用 POST /api/admin/recalibrate",
            "buckets": [],
        }
    return {
        "loaded": True,
        "bucket_size": cal.BUCKET_SIZE,
        "smoothing_window": cal.SMOOTHING_WINDOW,
        "bucket_count": len(cal.buckets),
        "buckets": [
            {
                "elo_range": f"{b.elo_lo:.0f}-{b.elo_hi:.0f}",
                "elo_lo": b.elo_lo,
                "elo_hi": b.elo_hi,
                "sample_size": b.sample_size,
                "actual_win_rate": round(b.actual_win_rate, 4),
                "raw_p_win": round(b.raw_p_win, 4),
                "calibrated_p_win": round(b.calibrated_p_win, 4),
                "bias": round(b.bias, 4),
            }
            for b in cal.buckets
        ],
    }


@app.post(
    "/api/admin/recalibrate",
    tags=["管理"],
    summary="从历史数据重新构建 Elo 校准表",
    description=(
        "扫描所有有双方 RatingHistory 的比赛，按 |ΔElo| 分桶聚合，\n"
        "再用样本量加权滑动平均平滑，输出 `data/calibration.json`。\n"
        "调用 `/api/predict` 时会自动应用最新校准表。"
    ),
)
def api_recalibrate():
    """重建 Elo 校准表。"""
    from .calibration import recalibrate
    n = recalibrate()
    return {
        "ok": True,
        "matches_processed": n,
        "message": f"校准完成，处理 {n} 场比赛。预测接口已自动应用。",
    }
