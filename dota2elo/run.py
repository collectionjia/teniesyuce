"""CLI 入口：ingest / serve / predict / show。"""
from __future__ import annotations

import argparse
import json
import sys


def cmd_ingest(args):
    from dota2elo.ingest import full_ingest
    print(f"开始拉取与计算（source={args.source}，max_pages={args.limit}）...")
    stats = full_ingest(max_pages=args.limit, enrich_top_n=args.enrich, source=args.source)
    print("完成：")
    for k, v in stats.items():
        print(f"  {k}: {v}")


def cmd_serve(args):
    import uvicorn
    from dota2elo.db import init_db
    init_db()
    print(f"启动 Dota2 Elo Web 服务 -> http://{args.host}:{args.port}（默认 3001，可用 --port 修改）")
    uvicorn.run(
        "dota2elo.api:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


def cmd_predict(args):
    from dota2elo.ingest import find_team, predict_match
    a_candidates = find_team(args.a)
    b_candidates = find_team(args.b)
    if not a_candidates or not b_candidates:
        print(f"未找到战队：{args.a!r} 或 {args.b!r}")
        return 1
    a = a_candidates[0]
    b = b_candidates[0]
    # 若有多个候选，让用户确认
    if len(a_candidates) > 1 or len(b_candidates) > 1:
        print(f"使用匹配：{a['name']} vs {b['name']}（如不对请用 id 精确指定）")
    result = predict_match(a["id"], b["id"])
    if not result:
        print("预测失败")
        return 1
    print("=" * 60)
    print(f"{result['team_a_name']:<30} Elo {result['team_a_rating']:>7.1f}")
    print(f"{result['team_b_name']:<30} Elo {result['team_b_rating']:>7.1f}")
    print("-" * 60)
    print(f"  {result['team_a_name']} 胜率: {result['p_a_win'] * 100:5.1f}%")
    print(f"  {result['team_b_name']} 胜率: {result['p_b_win'] * 100:5.1f}%")
    print("=" * 60)
    return 0


def cmd_show(args):
    from dota2elo.ingest import find_team
    candidates = find_team(args.team)
    if not candidates:
        print(f"未找到战队：{args.team!r}")
        return 1
    t = candidates[0]
    if len(candidates) > 1:
        print(f"使用匹配：{t['name']}（如不对请用 id 精确指定）")
    print("=" * 50)
    print(f"  {t['name']} (#{t['id']})")
    print(f"  Elo: {t['rating']}")
    print(f"  战绩: {t['wins']}胜 / {t['losses']}负 ({t['matches_played']} 场)")
    if t['matches_played']:
        print(f"  胜率: {t['wins'] / t['matches_played'] * 100:.1f}%")
    print("=" * 50)
    return 0


def cmd_cross_check(args):
    """对比两个源：open vs stratz。需要 STRATZ_API_KEY。"""
    import asyncio
    import json as _json
    import os
    from dota2elo.opendota import OpenDotaClient
    from dota2elo.sources.cross_check import cross_check
    from dota2elo.stratz import StratzClient

    if not os.getenv("STRATZ_API_KEY"):
        print("错误：cross-check 需要设置 STRATZ_API_KEY 环境变量")
        return 1

    a = OpenDotaClient()  # 不走缓存，强制实时拉取
    b = StratzClient()

    async def _go():
        return await cross_check(a, b, max_pages=args.pages, sample_team_ids=args.teams)

    report = asyncio.run(_go())
    print(_json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0


def cmd_cache(args):
    from dota2elo.sources.cache import cache_stats, clear_cache
    if args.action == "stats":
        s = cache_stats()
        print(f"缓存：total={s['total']}  expired={s['expired']}")
    elif args.action == "clear":
        n = clear_cache()
        print(f"已清空 {n} 条")


def cmd_import_pro_db(args):
    """从 dota-pro-db 预构建 SQLite 导入历史 T1 比赛。"""
    from dota2elo.importers.dota_pro_db import import_dota_pro_db
    print(f"从 {args.path} 导入...")
    stats = import_dota_pro_db(args.path)
    print("完成：")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


def cmd_import_betty(args):
    """从 Betty HuggingFace 数据集 (matches.parquet) 导入。"""
    try:
        from dota2elo.importers.betty_hf import import_betty
    except ImportError as e:
        print(f"❌ 缺依赖: {e}")
        print("   运行: pip install pyarrow")
        return 1
    print(f"从 {args.path} 导入...")
    stats = import_betty(args.path)
    print("完成：")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


def cmd_schedule(args):
    import json as _json
    from dota2elo import scheduler

    if args.action == "install":
        backend, msg = scheduler.install(every=args.every)
        print(f"[{backend}] {msg}")
        print()
        print("提示：")
        print("  - macOS launchd 任务立即跑一次（RunAtLoad=true），然后每 {0} 重跑".format(args.every))
        print("  - 任务独立于 'serve'，你关掉 Web 也照跑")
        print("  - 停止：python run.py schedule uninstall")
        print("  - 日志：data/ingest.log  |  python run.py schedule logs")
        return 0
    if args.action == "uninstall":
        ok = scheduler.uninstall()
        if ok:
            print("已卸载")
        else:
            print("未发现已安装的调度任务，无需处理")
        return 0
    if args.action == "status":
        s = scheduler.status()
        print(_json.dumps(s, indent=2, ensure_ascii=False))
        return 0
    if args.action == "logs":
        content = scheduler.tail_logs(n=args.lines)
        if content is None:
            print("(尚无日志)")
        else:
            print(content)
        return 0
    if args.action == "doctor":
        issues = scheduler.doctor()
        if not issues:
            print("✓ 调度环境检查通过")
            return 0
        print(f"发现 {len(issues)} 个问题：\n")
        for i, iss in enumerate(issues, 1):
            sev = {"error": "❌", "warning": "⚠️", "info": "ℹ️"}.get(iss["severity"], "•")
            print(f"{sev} [{iss['code']}] {iss['message']}")
            if iss.get("fix"):
                print(f"   修复：{iss['fix']}")
            print()
        return 0 if not any(i["severity"] == "error" for i in issues) else 1
    return 1


def main():
    parser = argparse.ArgumentParser(prog="dota2elo", description="Dota2 战队 Elo 系统")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ingest = sub.add_parser("ingest", help="拉取职业比赛并全量重算 Elo")
    p_ingest.add_argument(
        "--source", default="auto",
        choices=["auto", "opendota", "stratz", "multi"],
        help="数据源：auto/opendota/stratz/multi（默认 auto，配了 STRATZ_API_KEY 自动用 stratz+opendota 兜底）",
    )
    p_ingest.add_argument("--limit", type=int, default=20, help="拉取页数（每页 100 场，默认 20 = 约 2000 场）")
    p_ingest.add_argument("--enrich", type=int, default=50, help="拉取元数据的战队数")
    p_ingest.set_defaults(func=cmd_ingest)

    p_serve = sub.add_parser("serve", help="启动 Web 服务")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=3001)
    p_serve.add_argument("--reload", action="store_true", help="开发模式自动重载")
    p_serve.set_defaults(func=cmd_serve)

    p_pred = sub.add_parser("predict", help="命令行预测两队胜负")
    p_pred.add_argument("a", help="战队 A 名称或 id")
    p_pred.add_argument("b", help="战队 B 名称或 id")
    p_pred.set_defaults(func=cmd_predict)

    p_show = sub.add_parser("show", help="查看战队信息")
    p_show.add_argument("team", help="战队名称或 id")
    p_show.set_defaults(func=cmd_show)

    p_xc = sub.add_parser("cross-check", help="对比两个数据源的输出（诊断用，需要 STRATZ_API_KEY）")
    p_xc.add_argument("--pages", type=int, default=1, help="对比的比赛页数（每页 100 场）")
    p_xc.add_argument("--teams", type=int, nargs="*", default=None, help="指定要对比的 team_id 列表")
    p_xc.set_defaults(func=cmd_cross_check)

    p_cache = sub.add_parser("cache", help="查看/清空数据源缓存")
    p_cache.add_argument("action", choices=["stats", "clear"], help="stats=查看, clear=清空")
    p_cache.set_defaults(func=cmd_cache)

    p_sched = sub.add_parser("schedule", help="安装/卸载自动调度（launchd on macOS, cron on Linux）")
    p_sched.add_argument("action", choices=["install", "uninstall", "status", "logs", "doctor"], help="操作")
    p_sched.add_argument("--every", default="6h", help="运行频率，例如 1h / 6h / 12h / 1d（默认 6h）")
    p_sched.add_argument("--lines", type=int, default=50, help="logs 子命令显示最近 N 行")
    p_sched.set_defaults(func=cmd_schedule)

    p_import = sub.add_parser("import-pro-db", help="从 dota-pro-db 预构建 SQLite 导入历史 T1 比赛")
    p_import.add_argument("path", help="dota-pro-games.db 文件路径")
    p_import.set_defaults(func=cmd_import_pro_db)

    p_betty = sub.add_parser("import-betty", help="从 Betty HuggingFace 数据集 (matches.parquet) 导入")
    p_betty.add_argument("path", help="matches.parquet 文件路径（需 pip install pyarrow）")
    p_betty.set_defaults(func=cmd_import_betty)

    p_recal = sub.add_parser("recalibrate", help="从历史数据重新构建 Elo 差→胜率 校准表")
    p_recal.set_defaults(func=cmd_recalibrate)

    p_auto = sub.add_parser("auto-update", help="自动更新管道：ingest → recalibrate → （可选）HC@75")
    p_auto.add_argument("--source", default="auto", help="数据源 (auto/opendota/stratz/multi)")
    p_auto.add_argument("--max-pages", type=int, default=5, help="ingest 拉取页数（每页 ~100 场）")
    p_auto.add_argument("--no-recalibrate", action="store_true", help="跳过 recalibrate")
    p_auto.add_argument("--with-hc75", action="store_true", help="跑 HC@75 验证（耗时较长）")
    p_auto.set_defaults(func=cmd_auto_update)

    p_status = sub.add_parser("auto-status", help="查看最近一次 auto-update 的状态")
    p_status.set_defaults(func=cmd_auto_status)

    p_log = sub.add_parser("auto-log", help="查看 auto-update 的日志")
    p_log.add_argument("--lines", type=int, default=30, help="显示最近 N 行")
    p_log.set_defaults(func=cmd_auto_log)

    args = parser.parse_args()
    rc = args.func(args)
    sys.exit(rc or 0)


def cmd_auto_update(args):
    """自动更新管道。"""
    from dota2elo.auto_update import auto_update
    result = auto_update(
        source=args.source,
        max_pages=args.max_pages,
        recalibrate_after=not args.no_recalibrate,
        run_hc75=args.with_hc75,
    )
    print()
    print("=" * 60)
    print(f"  自动更新{'✅ 成功' if result.success else '❌ 失败'}")
    print("=" * 60)
    print(f"  总耗时:       {result.total_duration_sec:.1f}s")
    print(f"  新增比赛:     {result.new_matches}")
    print(f"  战队:         {result.n_teams_before} → {result.n_teams_after}")
    print(f"  比赛:         {result.n_matches_before} → {result.n_matches_after}")
    for s in result.steps:
        ok = "✅" if s.success else "❌"
        print(f"  {ok} {s.name:<12} {s.duration_sec:.1f}s  {s.message[:60]}")
    if result.error:
        print(f"  错误: {result.error}")
    return 0 if result.success else 1


def cmd_auto_status(args):
    """看最近一次 auto-update 状态。"""
    from dota2elo.auto_update import get_last_status
    import json
    status = get_last_status()
    print(json.dumps(status, indent=2, ensure_ascii=False))
    return 0 if status.get("success", True) else 1


def cmd_auto_log(args):
    """看 auto-update 日志。"""
    from dota2elo.auto_update import get_log_tail
    print(get_log_tail(args.lines))
    return 0


def cmd_recalibrate(args):
    """从历史数据重新构建 Elo 校准表。"""
    from dota2elo.calibration import recalibrate, get_calibration
    n = recalibrate()
    print(f"\n✅ 校准完成，处理 {n} 场比赛\n")
    print(get_calibration().summary())
    return 0


if __name__ == "__main__":
    main()
