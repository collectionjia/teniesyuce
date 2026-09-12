# 调度中心与 API 对外中心 · 设计说明

生成时间：2026-09-09  
地位：**目标架构补充文档**，与《盘中采集产品-全链路说明》并列；产品口径、三桶、三引擎职责以全链路说明为准，本文只定义 **调度中心** 与 **API 对外中心**。

---

## 0. 为什么要加这两层

当前目标架构里已有三类业务引擎（管理员统一管理）：

| 引擎 | 职责（摘要） |
|------|----------------|
| **采集引擎** | 全量拆三桶、盘中 tick、迁桶 |
| **条件引擎** | 管理员筛选规则；条件打开/关闭 |
| **投注引擎** | 管理员买入/止损规则；投注打开/关闭 |

缺口：

1. **何时跑、跑多频、失败怎么重试、多任务怎么互斥**——分散在进程内 `setInterval` / 启动钩子里，难以统一编排与审计。  
2. **对外能力**——产品页、监控、第三方脚本、运维面板若直接打内部 service，边界不清、鉴权难统一。

因此新增两层：

- **调度中心 UI / 规则配置**：仍仅 **管理员** 在后台改（与全链路说明一致）。  
- **`/api/engine/*`**：凭 **API Key（或等价密钥）** 调用；**不看角色**——普通用户、代理、管理员，只要持有有效密钥即可调引擎接口。


```
┌─────────────────────────────────────────────────────────┐
│                    管理员后台 / 运维                      │
└────────────┬──────────────────────────────┬─────────────┘
             │                              │
             ▼                              ▼
    ┌────────────────┐            ┌────────────────────┐
    │   调度中心      │◄──────────►│   API 对外中心      │
    │  (编排 · 启停)  │            │  (统一出口 · 鉴权)  │
    └───────┬────────┘            └─────────┬──────────┘
            │ 触发 / 约束                    │ 转发 / 聚合
            ▼                               ▼
   ┌────────┴────────┬──────────────┐
   │ 采集引擎 │ 条件引擎 │ 投注引擎   │  （+ 调度引擎自身状态）
   └─────────────────┴──────────────┘
            │
            ▼
        Redis 三桶 / tradeRecords / 规则配置
```

约定：

- **调度中心** 不替代引擎业务逻辑，只负责任务编排与生命周期。  
- **API 对外中心** 不重复实现策略，只做鉴权、限流、契约、审计，再调用内部引擎/调度。  
- **条件引擎** 仍以「规则 + 开关」为主，一般 **不进入周期调度**（按需评估即可）；调度中心主要编排 **采集** 与 **投注**（及可选的迁桶/对账任务）。

---

## 1. 调度中心（Scheduler Center）

### 1.1 定位

统一管理「可调度任务」的注册、启停、间隔、错峰、互斥与运行日志。  
管理员在后台 **调度中心** 页面：

- 新增 / 编辑调度任务  
- 绑定目标引擎（采集 / 投注，及后续扩展）  
- 配置 cron 或固定间隔  
- 查看最近一次执行状态、失败原因、下次计划时间  

### 1.2 可调度对象（首期）

| 任务类型 `jobType` | 绑定引擎 | 说明 | 默认建议 |
|--------------------|----------|------|----------|
| `collect.full` | 采集引擎 | 全量：IPWO→Sofascore → 拆三桶 | 间隔（如 60–300s）或 cron |
| `collect.inplay_tick` | 采集引擎 | 盘中 tick：直连 Polymarket 刷价/迁 settled | `inplay_tick_interval_sec` |
| `collect.migrate_prematch` | 采集引擎 | 开赛时间到 → prematch→inplay | 可并入 full，或独立短间隔 |
| `bet.scan` | 投注引擎 | 扫描候选场，按管理员规则买入 | 依赖「投注打开」+ 采集新鲜度 |
| `bet.stop_loss` | 投注引擎 | 盘中持仓止损扫描 | 可与 `bet.scan` 同 tick，或单独更频 |

非首期、可预留：

| `jobType` | 说明 |
|-----------|------|
| `condition.reindex` | 条件规则变更后异步重建候选索引（可选） |
| `reconcile.day` | 日界对账 / 空桶清理 |
| `settled.stats_refresh` | 盘后统计缓存刷新 |

**不调度**：条件引擎的「条件打开」开关与规则本身——那是配置态，由管理员即时生效；列表读路径按开关过滤即可。

### 1.3 任务模型（逻辑）

```text
SchedulerJob {
  id                // 稳定 ID
  name              // 展示名
  jobType           // 上表枚举
  engine            // collect | bet | condition | system
  enabled           // 任务级开关（与引擎总开关 AND）
  schedule: {
    mode            // interval | cron
    intervalSec?    // mode=interval
    cron?           // mode=cron，时区默认 Asia/Shanghai
  }
  params            // 任务参数（如 product 范围、batchSize）
  constraints: {
    mutexKey?       // 仅约束「定时执行」：同 key 同时只跑一个定时实例
    skipIfRunning   // 仅约束「定时执行」：上轮定时未结束则跳过本轮定时
    requireEngineOn // 依赖的引擎总开关（如投注打开）；定时与立即执行均校验
    requireJobs?    // 可选：依赖其它 job 近期成功（如 bet 依赖 collect）
  }
  createdBy / updatedAt
}
```

**已定：调度配置存 DB**（`SchedulerJob` 表）；Redis 仅作多实例锁 / 短时状态，不作配置主存。

执行记录：

```text
SchedulerRun {
  jobId, runId, startedAt, finishedAt
  trigger           // schedule | manual   （定时 | 立即执行）
  status            // success | failed | skipped | timeout
  message / error
  metrics           // 可选：写入场数、下单笔数等摘要
}
```

### 1.4 与现有引擎开关的关系

| 层级 | 作用 |
|------|------|
| **引擎总开关**（采集启停 / 条件打开 / 投注打开） | 产品级总闸；全链路说明已定 |
| **调度任务 `enabled`** | 该任务是否参与编排 |
| **调度中心进程/模块启停** | 整个调度器是否在跑 |

生效规则：

```
定时执行 = 调度中心在跑
         ∧ 任务 enabled
         ∧ 引擎总开关满足 requireEngineOn
         ∧ 未命中互斥/跳过（mutexKey / skipIfRunning）

立即执行 = 调度中心在跑（模块可用）
         ∧ 任务存在
         ∧ 引擎总开关满足 requireEngineOn
         ∧ 不占用、不等待定时互斥锁 —— 可与进行中的定时/其它立即执行并行
```

例：

- `bet.scan`：`投注打开` = false → 定时与立即执行均 **skipped**（记日志，不算失败）。  
- `collect.inplay_tick`：采集引擎停 → 不跑 tick。  
- 条件打开与否 **不阻止** 采集/投注调度；只影响 **列表** 过滤。投注引擎读采集桶 + 自身买入/止损规则，**不**再套条件引擎结果。  
- 某 job 定时轮次仍在跑时，管理员点「立即执行」→ **另开一轮**（`trigger=manual`），不排队、不打断定时轮。

### 1.5 运行时行为

1. **单进程优先**：与现网 Node 服务同进程内嵌调度循环即可（替换散落的 `start()` interval）；多实例部署时，**定时**抢主用 Redis 锁 `mutexKey`；**立即执行不参与该锁**。  
2. **定时触发**：到点 → 校验约束 → 调内部引擎入口（如 `runFullCollect()` / `runInplayTick()` / `runBettingScan()`），不经 HTTP 绕一圈。  
3. **立即执行（已定：可并行）**：`POST .../jobs/:id/run` 直接起独立 `SchedulerRun`（`trigger=manual`），与同 job 的定时执行、其它 manual 跑次 **并行**；不入定时队列、不被 `skipIfRunning` 挡掉。引擎侧需自行容忍并发（幂等写桶 / 下单去重），调度层不串行化。  
4. **超时**：任务级 `timeoutSec`；超时记 `timeout`；定时持锁则释放锁（manual 无该锁）。  
5. **失败**：记 `failed` + 错误摘要；可选简单退避（仅影响后续**定时**间隔），首期可只告警不自动改间隔。  
6. **审计**：最近 N 次 `SchedulerRun` 可查（区分 schedule / manual）；管理员 UI 展示「上次成功 / 上次失败」。

### 1.6 管理员 UI（调度中心页）

建议区块：

1. **任务列表**：名称、类型、绑定引擎、间隔/cron、启用、上次状态、操作（启停/编辑/立即执行一次）。  
2. **新建任务**：选 `jobType` → 填 schedule + params + 约束。  
3. **运行日志**：按 job 筛选。  
4. **只读依赖图**（可选）：采集 full → tick → 投注 scan 的建议顺序说明。

权限：**调度中心网页**仅管理员；**HTTP `/api/engine/*`** 见 §2.2 / §3（凭密钥，不按角色）。


### 1.7 和代码落点的映射（实现提示，非强制）

| 现状 | 调度中心接管后 |
|------|----------------|
| `tennisInplayTickLoop.start()` 进程启动即跑 | 注册为 `collect.inplay_tick`，由调度器启停 |
| 全量采集脚本/定时 | 注册为 `collect.full` |
| 投注引擎若「跟 tick」或独立扫 | 注册为 `bet.scan` / `bet.stop_loss` |

内部仍调用现有 `services/tennis*`；调度中心是编排层，不是第二套业务实现。

---

## 2. API 对外中心（API Gateway / Public Engine API）

### 2.1 定位

对外统一 HTTP（及后续可扩展 WebSocket）出口，覆盖：

| 域 | 对外暴露的能力类型 |
|----|-------------------|
| **采集引擎** | 状态查询、触发一次全量/tick（管理员）、健康与水位 |
| **条件引擎** | 规则摘要（只读）、条件开关状态、按规则试算/预览 |
| **投注引擎** | 开关状态、规则摘要、扫描状态、（管理员）干跑 dry-run |
| **调度引擎** | 任务 CRUD、启停、立即执行、运行日志 |

产品展示与用户下单（`/api/tennis-prematch|inplay|settled/...`）**可继续走现有产品路由**；对外中心专注 **引擎与调度运维面**，避免与 C 端列表接口混在同一契约里。若日后要「一个 base path 对外」，可在网关层再挂产品路由，本文不强制合并。

### 2.2 统一约定

- **Base path**：`/api/engine`（建议）  
- **鉴权（已定）**：请求须带有效 **API Key**（如 Header `Authorization: Bearer <key>` 或 `X-Api-Key`）。**不校验调用方在系统里的角色**（用户 / 代理 / 管理员均可）；有密钥就能调本中心接口（含只读与触发类）。无密钥或密钥无效 → 一律拒绝。  
- **与后台网页分离**：未持密钥的登录用户（含管理员 Session）**不能**单靠网页登录态调 `/api/engine/*`（除非另行发 Key）；网页上的规则/开关仍按全链路「仅管理员」管。  
- **密钥治理**：由管理员（或运维）签发、吊销、绑定备注；可选绑定 IP、过期时间、scope（P1）。审计记 `keyId` / 持有人，不记明文密钥。  
- **幂等**：触发类接口带 `Idempotency-Key` 或 `clientRequestId`（可选）。  
- **审计**：所有写操作与「立即执行」记 audit log（who/keyId / when / action / result）。  
- **限流**：触发全量采集、立即投注扫描等昂贵操作单独限流（按 key）。  
- **错误码**：业务错误用稳定 `code`（如 `ENGINE_OFF`、`JOB_LOCKED`、`CONDITION_OFF`、`INVALID_API_KEY`）。


### 2.3 路由草案

#### 2.3.1 采集引擎 ` /api/engine/collect `

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/status` | 采集是否在跑、上次全量/tick 时间、三桶条数摘要 | API Key |
| POST | `/full/run` | 触发一次全量采集（异步 jobId） | API Key |
| POST | `/inplay-tick/run` | 触发一次 tick | API Key |
| GET | `/health` | 依赖（IPWO/Sofascore/Polymarket）可达性粗检 | API Key |

不对外：原始爬虫凭证、内部 Redis 写细节。

#### 2.3.2 条件引擎 ` /api/engine/condition `

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/status` | 条件打开与否、各桶开关与组数 | API Key |
| GET | `/rules` | 完整规则（open + buckets） | API Key |
| PUT | `/rules` | 整表更新 `{ open?, buckets? }` | API Key |
| POST | `/switch` | body `{ open: boolean }` 总开关 | API Key |
| GET | `/rules/:bucket` | 单桶（`prematch` \| `inplay` \| `settled`） | API Key |
| PUT | `/rules/:bucket` | 替换桶 `{ enabled?, groups? }` | API Key |
| PATCH | `/rules/:bucket` | 只改桶开关 `{ enabled }` | API Key |
| POST | `/rules/:bucket/groups` | 新增条件组（body=组对象） | API Key |
| PATCH | `/rules/:bucket/groups/:index` | 部分更新条件组 | API Key |
| PUT | `/rules/:bucket/groups/:index` | 整组替换 | API Key |
| DELETE | `/rules/:bucket/groups/:index` | 删除条件组（可删到空） | API Key |
| POST | `/preview` | body：样本 event 或 product → 是否命中（可选后续） | API Key |

条件组字段示例：`name`、`joinPrev`（`and`\|`or`）、`tour`、`pm`、`gapMin`、`rankDiffMin`、`rankDiffMax`、`strongRankMax`、`gapMode`。

请求头：`X-Api-Key: eng_...` 或 `Authorization: Bearer eng_...`。

#### 2.3.3 投注引擎 ` /api/engine/betting `

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/status` | 投注打开与否、上次扫描、今日自动单摘要 | API Key |
| GET | `/rules` | 买入/止损规则摘要 | API Key |
| PUT | `/rules` | 更新规则 | API Key |
| POST | `/switch` | body `{ open: boolean }` | API Key |
| POST | `/scan/run` | 触发一次扫描（尊重投注打开；可带 `dryRun`） | API Key |
| POST | `/stop-loss/run` | 触发一次止损扫描 | API Key |

约定：`dryRun=true` 只返回「将下单列表」，不写成交。

#### 2.3.4 调度引擎 ` /api/engine/scheduler `

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/jobs` | 任务列表 | API Key |
| POST | `/jobs` | 新建任务 | API Key |
| GET | `/jobs/:id` | 详情 | API Key |
| PATCH | `/jobs/:id` | 更新 schedule/params/enabled | API Key |
| DELETE | `/jobs/:id` | 删除（或软删） | API Key |
| POST | `/jobs/:id/enable` · `/disable` | 快捷启停 | API Key |
| POST | `/jobs/:id/run` | 立即执行一次（校验引擎开关；**可并行**，不过定时互斥） | API Key |
| GET | `/jobs/:id/runs` | 运行日志分页 | API Key |
| GET | `/status` | 调度中心是否在跑、当前持锁任务 | API Key |

### 2.4 响应形态（统一）

```json
{
  "ok": true,
  "data": { },
  "meta": {
    "requestId": "...",
    "serverTime": "2026-09-09T08:00:00+08:00"
  }
}
```

异步触发：

```json
{
  "ok": true,
  "data": {
    "accepted": true,
    "runId": "run_xxx",
    "jobId": "collect.full",
    "status": "queued"
  }
}
```

随后用 `GET /api/engine/scheduler/jobs/:id/runs` 或 `GET .../runs/:runId` 查结果。

### 2.5 调用关系（禁止事项）

- **对外中心 → 内部 service**：允许（同步调用或投递到调度队列）。  
- **调度中心 → 对外中心 HTTP**：禁止（避免环路）；调度直接调 service。  
- **产品 C 端 API → 直接改调度任务**：禁止；改调度只走 `/api/engine/scheduler`（须 API Key）。  
- **无 API Key → 任意角色均不可调 `/api/engine/*`**；有 Key 则角色不限。


```
外部调用方
    │  HTTPS + 鉴权
    ▼
API 对外中心 (/api/engine/*)
    │
    ├─► collect / condition / betting services
    └─► scheduler service（CRUD + enqueue）
              │
              └─► 到期直接调 engines（不回 HTTP）
```

---

## 3. 权限与安全（汇总）

分两条线，不要混：

| 入口 | 谁能用 | 说明 |
|------|--------|------|
| **管理后台网页**（规则、条件/投注开关、调度中心 UI） | **仅管理员角色** | 与全链路说明一致；用户/代理登录也改不了 |
| **`/api/engine/*`** | **持有有效 API Key 的调用方** | **不看角色**：用户/代理/管理员只要有密钥就能调 |

| 能力 | 用户（无 Key） | 代理（无 Key） | 管理员（无 Key） | 任意角色 + 有效 API Key |
|------|----------------|----------------|------------------|-------------------------|
| 看三产品列表 | ✓ | ✓ | ✓ | ✓（列表仍走产品 API） |
| 手动下单（产品 API） | ✓（有钱包等） | 按现网 | ✓ | 同左 |
| 网页改条件/投注规则、引擎开关、调度 UI | ✗ | ✗ | ✓ | —（网页仍按角色） |
| 调 `/api/engine/*`（含 status、触发、调度 CRUD） | ✗ | ✗ | ✗ | ✓ |

密钥由管理员签发给需要机器调用/集成的账号；吊销即失效。有 Key ≈ 引擎运维能力，须保管好。

---

## 4. 数据与存储（已定口径）

| 数据 | 存储 | 说明 |
|------|------|------|
| `SchedulerJob` | **MySQL（主存）** | 调度配置唯一真相源；启动/变更从 DB 加载 |
| `SchedulerRun` | **MySQL** | 定时与立即执行均落库；保留近 7–30 天可归档 |
| 引擎开关 / 规则 | 沿用现有配置存储 | 条件/投注规则 CRUD **P0 仍走原管理接口**；`/api/engine/condition` 先做 status + 只读聚合 |
| 定时互斥锁 | Redis：`scheduler:lock:{mutexKey}` | **仅定时**；立即执行不加此锁 |
| API 审计 | DB 或日志流水 | — |

三桶键名不变：`tennis:bundle:prematch|inplay|settled`。

### 4.1 MySQL 表结构（建议）

与现网 `trade_records` 等一致：`InnoDB` + `utf8mb4`，服务启动 `CREATE TABLE IF NOT EXISTS`。

```sql
CREATE TABLE IF NOT EXISTS scheduler_jobs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  job_type VARCHAR(64) NOT NULL,
  engine VARCHAR(32) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_mode VARCHAR(16) NOT NULL,          -- interval | cron
  interval_sec INT NULL,
  cron_expr VARCHAR(64) NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  params_json JSON NULL,
  mutex_key VARCHAR(128) NULL,
  skip_if_running TINYINT(1) NOT NULL DEFAULT 1,
  require_engine_on VARCHAR(64) NULL,         -- 如 collect | betting
  timeout_sec INT NOT NULL DEFAULT 300,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sched_jobs_enabled (enabled),
  INDEX idx_sched_jobs_type (job_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  job_id VARCHAR(64) NOT NULL,
  trigger_type VARCHAR(16) NOT NULL,          -- schedule | manual
  status VARCHAR(16) NOT NULL,                -- success | failed | skipped | timeout | running
  message VARCHAR(512) NULL,
  error_msg VARCHAR(1024) NULL,
  metrics_json JSON NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  UNIQUE KEY uk_sched_run_id (run_id),
  INDEX idx_sched_runs_job_started (job_id, started_at),
  CONSTRAINT fk_sched_runs_job FOREIGN KEY (job_id) REFERENCES scheduler_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

P0 预置行（`enabled=1`，可按环境改间隔）：

| id | job_type | schedule | require_engine_on |
|----|----------|----------|-------------------|
| `job_collect_full` | `collect.full` | interval 可配 | `collect` |
| `job_collect_inplay_tick` | `collect.inplay_tick` | `interval_sec` ← 对齐 `inplay_tick_interval_sec` | `collect` |
| `job_bet_scan` | `bet.scan` | interval 可配 | `betting` |

---

## 5. 落地分期

### P0（先打通）

1. 调度中心：内嵌调度器 + 预置任务（`collect.full`、`collect.inplay_tick`、`bet.scan`）。  
2. 管理后台：调度中心页（列表 / 启停 / 改间隔 / 立即执行 / 最近日志）。  
3. API 对外中心：`/status` + `/run` + scheduler jobs 只读/启停（规则 CRUD 可仍用旧管理接口）。

### P1

1. 任务 CRUD 完整 API + UI 新建自定义任务。  
2. `dryRun`、运行指标、失败告警。  
3. 多实例 Redis 锁。

### P2

1. 依赖图、错峰窗口、按北京时间日界的特殊任务。  
2. API Key scope、OpenAPI 文档自动导出。  
3. 条件 `preview` / `reindex` 等增强。

---

## 6. 与全链路说明的衔接

| 全链路已定 | 本文增量 |
|------------|----------|
| 采集 / 条件 / 投注三引擎 + 管理员开关 | 增加 **调度中心** 编排采集与投注的周期任务 |
| 条件打开 / 投注打开语义 | 调度约束读取同一开关，语义不变 |
| 产品 API（today / trade / stats） | 保持独立；引擎运维走 `/api/engine` |
| 仅管理员改规则与开关（**网页**） | `/api/engine/*` 另按 **API Key**，不按角色 |


文首「管理员后台」树扩展为：

```
管理员后台
  ├── 采集引擎（启停 / 间隔配置入口可链到调度任务）
  ├── 条件引擎（规则 + 【条件打开】）
  ├── 投注引擎（规则 + 【投注打开】）
  ├── 调度中心（任务编排 · 日志 · 立即执行）
  └── API 对外中心（/api/engine/*，凭 API Key，不按角色）
```

---

## 7. 验收标准（设计级）

1. 管理员能在调度中心新增一条「采集全量」任务并改间隔，进程内按新间隔跑，无需改代码发版。  
2. 关闭「投注打开」后，`bet.*` 任务只跳过不报错；打开后自动恢复执行。  
3. 通过 `/api/engine/collect/status`、`/betting/status`、`/scheduler/jobs` 能读到与后台一致的状态。  
4. 无有效 API Key 调用 `/api/engine/*` 一律拒绝；有 Key 时不因角色为用户/代理而拒绝。  
5. 调度触发不经过公网 HTTP 自调用；与产品列表/下单 API 无环依赖。  
6. 定时执行占用互斥时，立即执行仍能并行起跑并各写一条 `SchedulerRun`（`trigger=manual`）。

---

## 8. 已定口径（设计收口）

1. **调度配置存 MySQL**（`scheduler_jobs` / `scheduler_runs`）；Redis 只做定时互斥锁，不作 Job 配置主存。  
2. **立即执行可并行**：不过定时 `mutexKey` / `skipIfRunning`；与定时及其它 manual 可同时跑；引擎需幂等/去重。  
3. **条件规则 CRUD**：已提供 `/api/engine/condition/rules*`（API Key）；网页仍可走原管理后台 `POST /api/admin/tennis-monitor/engines`。  
4. **`/api/engine/*` 鉴权 = API Key**：与角色无关；用户/代理/管理员持有效密钥均可调用。网页上的规则与调度 UI 仍仅管理员。

设计已收口，下一步按 **§5 P0** 开工实现即可。
