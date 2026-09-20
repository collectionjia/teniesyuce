"""
每日比赛预测：拉当日比赛 → 批量预测 → 排序

用法：
  python run.py ingest --source opendota --limit 2    # 先拉新数据
  python scripts/daily_predictions.py                  # 看今日预测

输出：每场预测的胜率 + 75%/80% 条件触发 + 是否能下注
"""
import sys
import os
from datetime import datetime, timedelta
import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

API = "http://127.0.0.1:3001"


def get_today_matches(hours_lookback: int = 24, hours_lookahead: int = 48):
    """从 DB 拿最近 hours_lookback + 未来 hours_lookahead 的职业比赛（含双方 Elo）。"""
    from dota2elo.db import session_scope
    from dota2elo.models import Match, Team

    now = datetime.now()
    past_cutoff = now - timedelta(hours=hours_lookback)
    future_cutoff = now + timedelta(hours=hours_lookahead)
    with session_scope() as s:
        rows = s.query(Match).filter(
            Match.start_time >= past_cutoff,
            Match.start_time <= future_cutoff,
            Match.radiant_team_id.isnot(None),
            Match.dire_team_id.isnot(None),
        ).order_by(Match.start_time).all()
        out = []
        for m in rows:
            a = s.get(Team, m.radiant_team_id)
            b = s.get(Team, m.dire_team_id)
            if not a or not b:
                continue
            out.append({
                "match_id": m.match_id,
                "start_time": m.start_time.isoformat(),
                "league_name": m.league_name or "?",
                "series_type": m.series_type or "bo1",
                "a_id": m.radiant_team_id,
                "b_id": m.dire_team_id,
                "a_name": a.name,
                "b_name": b.name,
                "a_elo": a.rating,
                "b_elo": b.rating,
            })
        return out


def predict_match(team_a_id: int, team_b_id: int, series_type: str = "bo3"):
    """调用 /api/predict，返回关键字段。"""
    st = 0 if series_type == "bo1" else (2 if series_type == "bo5" else 1)
    try:
        r = httpx.get(f"{API}/api/predict", params={
            "a": team_a_id, "b": team_b_id, "series_type": st,
        }, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def main():
    print("=" * 70)
    print(f"  每日比赛预测 - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 70)
    print()

    matches = get_today_matches(hours_lookback=24, hours_lookahead=48)
    print(f"过去 24h + 未来 48h 比赛: {len(matches)} 场\n")

    if not matches:
        print("无最近比赛。先跑：")
        print("  python run.py ingest --source opendota --limit 3")
        return

    results = []
    for m in matches:
        pred = predict_match(m["a_id"], m["b_id"], m["series_type"])
        if "error" in pred:
            continue

        results.append({
            **m,
            "p_a": pred["calibrated_p_a_win"],
            "p_b": pred["calibrated_p_b_win"],
            "meets_75": pred["meets_75_condition"],
            "meets_80": pred["meets_80_condition"],
            "exp_75": pred["winrate_75_expected"],
            "exp_80": pred["winrate_80_expected"],
            "best_75": pred["winrate_75_best_signal"],
            "best_80": pred["winrate_80_best_signal"],
            "roster_a": pred.get("roster_avg_elo_a", 0),
            "roster_b": pred.get("roster_avg_elo_b", 0),
            "completed": m["start_time"] < datetime.now().isoformat(),
        })

    # 按"可信度"排序：先 80% 触发，再 75% 触发，再按 calibrated_p
    def sort_key(r):
        return (
            0 if r["meets_80"] else (1 if r["meets_75"] else 2),
            -r["exp_75"],
        )
    results.sort(key=sort_key)

    print(f"{'#':<3} {'时间':<18} {'联赛':<22} {'对阵':<35} {'胜率':>6} {'触发':>8}")
    print("-" * 110)

    for i, r in enumerate(results, 1):
        when = datetime.fromisoformat(r["start_time"]).strftime("%m-%d %H:%M")
        league = r["league_name"][:20]
        matchup = f"{r['a_name']:<14} vs {r['b_name']:<14}"
        prob = f"{r['p_a']*100:.1f}%"
        trigger = "🟢 80%" if r["meets_80"] else ("🟡 75%" if r["meets_75"] else "—")
        exp = f"({r['exp_75']*100:.0f}%)" if r["meets_75"] else ""

        print(f"{i:<3} {when:<18} {league:<22} {matchup:<35} {prob:>6} {trigger:>4} {exp}")
        if r["meets_75"] or r["meets_80"]:
            sig = r.get("best_80") or r.get("best_75")
            print(f"     {'  └─ 信号:':<18} {sig}")
            print(f"     {'  └─ 阵容 Elo:':<18} {r['a_elo']:.0f} ({r['roster_a']:.0f}) vs {r['b_elo']:.0f} ({r['roster_b']:.0f})")

    print()
    # 总结
    n_80 = sum(1 for r in results if r["meets_80"])
    n_75 = sum(1 for r in results if r["meets_75"])
    print(f"📊 总结: 总 {len(results)} 场, 🟢 80% 触发 {n_80} 场, 🟡 75% 触发 {n_75} 场")


if __name__ == "__main__":
    main()
