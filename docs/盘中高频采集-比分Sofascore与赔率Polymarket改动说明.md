# 盘中高频采集纠偏：比分 Sofascore(IPWO) + 赔率 Polymarket

> 状态：待改（先方案，未动代码）  
> 背景：生产「盘中比分刷新」在跑，但 `refresh_inplay.py` 把**比分也改成读 Polymarket Gamma**，导致无 slug 场次刷不到、有 slug 的也往往盘末才更新。  
> 目标（产品约定）：

| 通道 | 数据源 | 代理 |
|------|--------|------|
| **高频比分** | Sofascore（event 详情 / live） | **必须经 IPWO**，禁止直连 |
| **高频赔率** | Polymarket（Gamma + CLOB mid） | **直连 Polymarket**（不走 IPWO） |
| **触发间隔** | 调度中心界面 `intervalSec` | 以界面已保存任务为准，不写死代码常量 |

---

## 1. 现状（错在哪）

```
调度 job（界面间隔）
  └─ collect.inplay_tick / collect.top100_hf
       └─ tennisInplayTick.runInplayTick()
            └─ tennisCollectRunner.runInplayRefreshAndWait()
                 └─ refresh_inplay.py
                      ├─ 比分 ← Polymarket Gamma   ❌ 应为 Sofascore+IPWO
                      └─ 赔率 ← Polymarket CLOB    ✅ 方向对
```

关键证据：

- `refresh_inplay.py` 头部注释已写死「比分/状态：Polymarket Gamma」
- 生产 tick 日志：`score miss … (no polymarket slug)`（例：Putintseva vs Bucsa 卡在 `0-0`）
- Node 注释仍写「比分(Sofascore)」，与 Python 实现不一致
- `tennisInplayTick.js` 把 `scores.upstream` 标成 `ipwo`，实际并未走 Sofascore

间隔本身**没有丢**：`SchedulerCenter` + `scheduler_jobs.interval_sec` 仍控制触发；问题是每次触发刷错了比分源。

---

## 2. 目标数据流

```
界面设置 intervalSec（≥10s，常用 30/60/120）
        │
        ▼
scheduler 到期触发 job_collect_inplay_tick（或 top100_hf）
        │
        ▼
runInplayTick()
  1. migratePrematchByStartTime / admitLiveFromFull   （已有，保留）
  2. 读 Redis tennis:bundle:inplay 已有 matches
  3. 【比分】IPWO → Sofascore 只刷这些 id 的状态/局分/scoreText
  4. 【赔率】Polymarket 直连刷 polymarketByEvent（有 slug 的场次）
  5. 完赛迁 settled / phaseMark / 可选投注 pass     （已有，保留）
```

原则：

- **不重跑** `collect_live.py` 全量发现；只刷包内已有场次（与现设计一致）
- 无比分源时（Sofascore 失败）应显式记 failed，**不要**静默用 PM 伪比分顶上
- 无 PM slug 时：**比分仍应更新**；赔率可 miss（与现在对称反过来）

---

## 3. 要改的文件（按优先级）

### P0 · 必改（行为纠偏）

| # | 文件 | 改什么 |
|---|------|--------|
| 1 | `scripts/tennis-monitor/refresh_inplay.py` | **主改点**。拆成两路：`refresh_scores_sofascore()`（IPWO+Sofascore）与现有 `refresh_from_polymarket(..., want_score=False)` 只刷赔率。`--scores-only` / `--odds-only` 语义对齐。 |
| 2 | `scripts/tennis-monitor/tm/collectors/events.py`（或新建小模块） | 复用/抽出「按 eventId 列表经 SofascoreClient 刷比分」：可基于现有 `refresh_live_set_scores` + `slim_event` / `_event_score`，把结果写回 Redis 包内 match（`scoreText`、`status`/`statusType`、`homeScore`/`awayScore`、period）。 |
| 3 | `scripts/tennis-monitor/tm/clients/proxy.py` | 确认 `COLLECT_PROXY_JOB=inplay` / `inplay_tick` 时 Sofascore **强制 IPWO**；Polymarket 请求路径不套 IPWO（现有 PM 客户端若已被全局 HTTP_PROXY 污染，需在刷赔率时剥离代理 env）。 |

### P1 · 对齐标注与可观测性

| # | 文件 | 改什么 |
|---|------|--------|
| 4 | `server/src/services/tennisInplayTick.js` | `scores.upstream` → 真实 `ipwo-sofascore`；`prices.via` / `upstream` → `polymarket`（直连）。失败日志区分「比分 miss」与「赔率 miss」。 |
| 5 | `server/src/services/tennisCollectRunner.js` | 注释/返回字段与实现一致；`proxyEnvForJob('inplay')` 只作用于 Sofascore 子进程段（若拆成两次 spawn，则 scores 子进程带 IPWO，odds 子进程清代理）。 |
| 6 | `docs/后台五服务/*.md`（止损/投注/规则里写「collect 30s partial」处） | 改成：比分 Sofascore(IPWO)、赔率 Polymarket；间隔以调度任务为准（勿写死 30s）。 |

### P2 · 可选（不改也能先修主路径）

| # | 文件 | 何时需要 |
|---|------|----------|
| 7 | `client/src/components/SchedulerCenter.vue` | 仅文案：标明「盘中比分= Sofascore(IPWO)，赔率= Polymarket」；**间隔控件已够用，逻辑不用改**。 |
| 8 | `server/src/services/schedulerStore.js` | 仅当要改默认预设秒数；**间隔以界面已存 `interval_sec` 为准，不必动**。 |
| 9 | `scripts/tennis-monitor/collect_live.py` / `tier_live_collect.py` | 全量发现路径，**本次不改**；高频不依赖它。 |

---

## 4. `refresh_inplay.py` 建议结构（实现提纲）

```text
main():
  bundle = read tennis:bundle:inplay
  matches = live.matches

  if want_score:
      scores = refresh_scores_via_sofascore(matches)   # IPWO + get_event / live
  if want_odds:
      _, prices = refresh_from_polymarket(matches, poly_map, want_score=False, want_odds=True)

  if want_score:
      move finished → settled（沿用现逻辑）

  write_live_bundle_redis(bundle)
  print SUMMARY { scores, prices, ... }
```

Sofascore 刷分要点：

1. `require_proxy` / `SofascoreClient`（与 `collect_live` 相同代理策略）
2. 对包内每个 `match.id`：`client.get_event(id)`（或 live 列表命中则合并，减少请求）
3. 用 `_event_score` / status 字典更新 `scoreText`、`statusType`、`status`、盘分
4. `SUMMARY.scores` 带：`updated` / `failed` / `missed[]` / `source: sofascore-ipwo`
5. **禁止**再调用 `apply_sport_state_to_match` 当主比分源

Polymarket 刷赔要点（保持）：

1. 仅有 slug 的场次
2. `apply_live_prices` → 写 `polymarketByEvent`
3. `SUMMARY.prices.source: polymarket-clob`
4. 子进程环境：**不**注入 IPWO（避免 PM 被代理拖慢/拦）

---

## 5. 明确不改 / 已满足

| 项 | 说明 |
|----|------|
| 调度间隔 | 界面 `SchedulerCenter` → MySQL `scheduler_jobs.interval_sec` → `schedulerLoop`；以线上任务配置为准 |
| 开关 | `CollectProxySettings` / engines `inplay_tick_enabled`、字段 `inplay_tick_fields.score/odds` 可继续用 |
| 全量 6h | `collect.top100` / `collect.py` 不动 |
| 对外读 API | `/api/tennis-inplay/*` 仍读 Redis，无需改路由 |

注意：`collect.inplay_tick` 与 `collect.top100_hf` **目前都进同一个** `runInplayTick()`。本次纠偏两者一并受益；若产品上要拆成「只刷 Top100」再另开需求。

---

## 6. 验收清单

1. 调度按界面间隔触发（改 30s/60s 后看 `scheduler_runs` / collect 容器日志时间戳）。
2. 进行中且**无 PM slug** 的场次：比分仍能从 Sofascore 更新（不再 `no polymarket slug` 导致 score miss）。
3. 有 PM 的场次：赔率 `home_price/away_price` 持续变；比分与 Sofascore 局分一致，不出现「两盘后才从 0-0 跳到终局」。
4. Sofascore 请求经 IPWO（日志/代理状态可见）；Polymarket 请求直连。
5. Parks 类场次：盘中 collect/refresh 日志应出现进行中比分行，而不仅是 `Not started`。

---

## 7. 建议实施顺序

1. 改 `refresh_inplay.py` 比分回 Sofascore(IPWO)，赔率保留 PM，本地/`215` 测一场 live。  
2. 修 Node 上游字段与日志。  
3. 发 **145 生产** 后看 `yuce-services-collect` 日志 + Redis `score_updated_at`。  
4. 补文档一句，避免后人再把比分接到 Gamma。

---

## 8. 一句话结论

**几乎只改采集脚本主路径**：把 `refresh_inplay.py` 的比分从 Polymarket 拨回 **IPWO→Sofascore**；赔率继续 **Polymarket 直采**；时间继续听 **调度中心界面**。Node/文档做标注对齐即可。
