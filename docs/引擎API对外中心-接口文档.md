# 引擎 API 对外中心 · 接口文档

生成时间：2026-09-09  
覆盖：

- `/api/engine/*`（API Key）：采集 / 条件只读 / 投注只读与触发 / 调度  
- `/api/admin/tennis-monitor/engines`（管理员 JWT）：**条件设置、投注设置**（及采集配置）

相关设计见 [`调度中心与API对外中心-设计.md`](./调度中心与API对外中心-设计.md)。

---

## 1. 鉴权

任选一种方式携带密钥（在管理后台「引擎 API Key」页签发）：

| 方式 | 示例 |
|------|------|
| Header `X-Api-Key` | `X-Api-Key: eng_xxxx` |
| Header `Authorization` | `Authorization: Bearer eng_xxxx`（须以 `eng_` 开头） |
| Query（不推荐） | `?apiKey=eng_xxxx` |

无密钥或密钥无效：

```json
{
  "ok": false,
  "error": "invalid api key",
  "code": "INVALID_API_KEY",
  "meta": { "requestId": "...", "serverTime": "..." }
}
```

HTTP **401**。

---

## 2. 统一响应

### 成功

```json
{
  "ok": true,
  "data": { },
  "meta": {
    "requestId": "可选，客户端可传 X-Request-Id",
    "serverTime": "2026-09-09T18:00:00+08:00",
    "keyId": 1
  }
}
```

### 失败

```json
{
  "ok": false,
  "error": "说明文字",
  "code": "ERROR_CODE",
  "meta": { "requestId": "...", "serverTime": "...", "keyId": 1 }
}
```

### 触发类（立即执行）

```json
{
  "ok": true,
  "data": {
    "accepted": true,
    "runId": "run_xxx",
    "jobId": "job_collect_full",
    "status": "success"
  },
  "meta": { }
}
```

`status` 常见值：`success` | `failed` | `skipped` | `timeout` | `running`。

立即执行（`trigger=manual`）**可与定时并行**，不过定时互斥锁。

---

## 3. 采集引擎 `/api/engine/collect`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/collect/status` | 采集开关、tick 间隔、三桶条数、最近全量/tick 运行 |
| GET | `/collect/health` | 粗健康：三桶是否可读 |
| POST | `/collect/full/run` | 立即执行一次全量拆三桶（manual） |
| POST | `/collect/inplay-tick/run` | 立即执行一次盘中 tick |

### GET `/collect/status` · data 字段

| 字段 | 说明 |
|------|------|
| `enabled` | 采集总开关 |
| `inplayTickEnabled` | 盘中 tick 是否开启 |
| `inplayTickIntervalSec` | tick 间隔秒 |
| `bucketCounts` | `{ prematch, inplay, settled }` 条数 |
| `lastFullRun` / `lastTickRun` | 最近一次运行摘要（可能为 null） |

### 示例

```bash
curl -s -H "X-Api-Key: eng_xxx" \
  https://你的域名/api/engine/collect/status

curl -s -X POST -H "X-Api-Key: eng_xxx" \
  https://你的域名/api/engine/collect/full/run
```

---

## 4. 条件引擎

分两层：

| 入口 | 鉴权 | 能力 |
|------|------|------|
| `/api/engine/condition/*` | API Key | **只读** status / rules |
| `/api/admin/tennis-monitor/engines` | 管理员 JWT | **读写**完整条件配置（设置） |

### 4.1 只读（API Key）`/api/engine/condition`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/condition/status` | 条件是否打开、各桶分组数量 |
| GET | `/condition/rules` | 当前规则配置（含 buckets） |

`GET /condition/status` · data：

| 字段 | 说明 |
|------|------|
| `open` | 条件总开关 |
| `buckets` | `{ prematch\|inplay\|settled: { enabled, groupCount } }` |

### 4.2 条件设置（管理员 JWT）

Base：`/api/admin/tennis-monitor`  
Header：`Authorization: Bearer <管理员登录 JWT>`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/engines` | 读取三引擎完整配置（含 condition / betting / collect） |
| POST | `/engines` | **部分更新**配置（deep merge；`condition.buckets` 整桶 groups 以提交为准） |

#### 打开 / 关闭条件

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"condition":{"enabled":true}}' \
  https://你的域名/api/admin/tennis-monitor/engines
```

#### 写入条件分组（示例：盘前）

```json
{
  "condition": {
    "enabled": true,
    "buckets": {
      "prematch": {
        "enabled": true,
        "groups": [
          {
            "name": "强现Top20",
            "joinPrev": "or",
            "tour": "all",
            "pm": "all",
            "gapMin": 50,
            "rankDiffMin": "all",
            "rankDiffMax": 0,
            "strongRankMax": 20,
            "gapMode": "all"
          }
        ]
      },
      "inplay": { "enabled": false, "groups": [] },
      "settled": { "enabled": false, "groups": [] }
    }
  }
}
```

注意：提交某个 bucket 时，该桶的 `groups` **整表替换**（不会与旧组残留合并）。未提交的桶保持原样。

#### 条件分组字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 分组名称（调度任务名称下拉会用到，建议填写） |
| `joinPrev` | `and` \| `or` | 与上一组关系；首组忽略 |
| `tour` | `all` \| `ATP`/`男` \| `WTA`/`女` 等 | 巡回赛 |
| `pm` | `all` \| `yes` \| `no` | 是否有 Polymarket |
| `gapMin` | number \| `all` | 现差下限（弱现排 − 强现排） |
| `rankDiffMin` / `rankDiffMax` | number \| `all` | 排差范围 |
| `strongRankMax` | number \| `all` | 强者现排上限（TopN） |
| `gapMode` | `all` \| 其它产品约定值 | 盘中现差模式等 |

组间按 `joinPrev` 链式求值；组内字段为 **且**。

桶键：`prematch`（盘前）/ `inplay`（盘中）/ `settled`（盘后）。

---

## 5. 投注引擎

| 入口 | 鉴权 | 能力 |
|------|------|------|
| `/api/engine/betting/*` | API Key | 只读 status/rules；触发 scan / stop-loss |
| `/api/admin/tennis-monitor/engines` | 管理员 JWT | **读写**投注设置（开关、邮箱、分组、止损） |

### 5.1 API Key 接口 `/api/engine/betting`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/betting/status` | 投注是否打开、金额、桶摘要、最近扫描 |
| GET | `/betting/rules` | 规则与 buckets 详情 |
| POST | `/betting/scan/run` | 立即执行投注扫描（预置 `job_bet_scan`） |
| POST | `/betting/stop-loss/run` | P0 与 scan 同源 |

未配置登录邮箱或「投注打开」关闭时，运行多为 `skipped`。

### 5.2 投注设置（管理员 JWT）

同一读写入口：`GET|POST /api/admin/tennis-monitor/engines`。

#### 打开投注 + 设置登录邮箱

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "betting": {
      "enabled": true,
      "userAccount": "trader@example.com",
      "amountUsd": 1
    }
  }' \
  https://你的域名/api/admin/tennis-monitor/engines
```

| 字段 | 说明 |
|------|------|
| `enabled` | 投注总开关（投注打开） |
| `userAccount` | **投注账号登录邮箱**（须为系统已存在用户的 `account`）；服务端解析为内部 `userId` |
| `userId` | 一般不必手填；可由邮箱解析得到 |
| `amountUsd` | 默认下单金额（USD） |

邮箱不存在时返回 400：`投注账号不存在：...`。

#### 写入投注分组（示例：盘中）

```json
{
  "betting": {
    "enabled": true,
    "userAccount": "trader@example.com",
    "amountUsd": 1,
    "buckets": {
      "inplay": {
        "enabled": true,
        "groups": [
          {
            "name": "盘中买入组A",
            "joinPrev": "or",
            "tour": "all",
            "pm": "yes",
            "gapMin": "all",
            "rankDiffMin": "all",
            "rankDiffMax": "all",
            "strongRankMax": "all",
            "pmMaxCents": 91,
            "requireWonFirstSet": true,
            "stopEnabled": true,
            "stopRules": [
              {
                "name": "第三盘止损",
                "joinPrev": "or",
                "stopFormat": "bo3",
                "stopSetIndex": 3,
                "stopStrongSets": "all",
                "stopWeakSets": "all",
                "stopGameLead": 2,
                "stopWeakGamesMin": "all"
              }
            ]
          }
        ]
      },
      "prematch": { "enabled": false, "groups": [] }
    }
  }
}
```

提交某桶时，该桶 `groups` **整表替换**。

#### 投注分组字段

| 字段 | 说明 |
|------|------|
| `name` | 分组名称（调度名称下拉用） |
| `joinPrev` | `and` \| `or` |
| `tour` / `pm` / `gapMin` / `rankDiff*` / `strongRankMax` | 同条件筛选口径 |
| `pmMaxCents` | Polymarket 价格上限（美分，如 91） |
| `requireWonFirstSet` | 是否要求已赢首盘（盘中常用） |
| `stopEnabled` | 是否启用止损 |
| `stopRules[]` | 止损规则列表 |

#### 止损规则 `stopRules[]`

| 字段 | 说明 |
|------|------|
| `name` | 规则名 |
| `joinPrev` | 与上一止损规则 `and` \| `or` |
| `stopFormat` | `bo3` \| `bo5` \| `any` |
| `stopSetIndex` | 盘序 1～5 |
| `stopStrongSets` / `stopWeakSets` | 强/弱方已胜盘数，或 `all` |
| `stopGameLead` | 局分领先阈值 |
| `stopWeakGamesMin` | 弱方局数下限，或 `all` |

投注桶键：仅 `prematch` / `inplay`（盘后不新开仓）。

#### 仅改开关示例

```bash
# 关闭投注
curl -s -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"betting":{"enabled":false}}' \
  https://你的域名/api/admin/tennis-monitor/engines
```

---

## 6. 调度引擎 `/api/engine/scheduler`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/scheduler/status` | 调度循环是否在跑、任务数 |
| GET | `/scheduler/jobs` | 任务列表 + `jobTypes` + `nameOptions` |
| POST | `/scheduler/jobs` | 新建任务 |
| GET | `/scheduler/jobs/:id` | 任务详情 |
| PATCH | `/scheduler/jobs/:id` | 更新名称/启停/时间/params |
| DELETE | `/scheduler/jobs/:id` | 删除任务（及运行日志） |
| POST | `/scheduler/jobs/:id/delete` | 同上（兼容部分代理对 DELETE 支持差） |
| POST | `/scheduler/jobs/:id/enable` | 启用 |
| POST | `/scheduler/jobs/:id/disable` | 停用 |
| POST | `/scheduler/jobs/:id/run` | 立即执行一次（可并行） |
| GET | `/scheduler/jobs/:id/runs` | 运行日志（`?limit=&offset=`） |
| GET | `/scheduler/runs/:runId` | 单次运行详情 |

### 6.1 任务类型 `jobType`

| jobType | 类别 | 说明 | 依赖引擎开关 |
|---------|------|------|--------------|
| `collect.full` | collect | 全量拆三桶 + 迁桶 | `collect` |
| `collect.inplay_tick` | collect | 盘中 tick | `collect` |
| `condition.query` | condition | 按条件分组筛场统计 | `condition` |
| `bet.scan` | betting | 投注扫描（可绑分组） | `betting` |

### 6.2 新建任务 POST `/scheduler/jobs`

Body 示例（间隔）：

```json
{
  "name": "强现差组",
  "jobType": "bet.scan",
  "scheduleMode": "interval",
  "intervalSec": 30,
  "enabled": true,
  "params": {
    "category": "betting",
    "bucket": "inplay",
    "groupIndex": 0,
    "groupName": "强现差组"
  }
}
```

每天定点（北京时间）：

```json
{
  "name": "采集",
  "jobType": "collect.full",
  "scheduleMode": "daily",
  "dailyTime": "09:00",
  "enabled": true,
  "params": { "category": "collect" }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `jobType` | 是 | 见上表 |
| `name` | 建议 | 展示名；采集一般为「采集」，条件/投注为分组名 |
| `scheduleMode` | 是 | `interval` \| `daily` |
| `intervalSec` | interval 时 | 秒，1～604800 |
| `dailyTime` | daily 时 | `HH:mm`（Asia/Shanghai） |
| `enabled` | 否 | 默认 true |
| `timeoutSec` | 否 | 超时秒 |
| `params` | 条件/投注建议 | `bucket` + `groupIndex` + `groupName` |

### 6.3 更新 PATCH `/scheduler/jobs/:id`

可传：`name`、`enabled`、`scheduleMode`、`intervalSec`、`dailyTime`、`timeoutSec`、`params`。

### 6.4 nameOptions（来自 GET `/scheduler/jobs`）

```json
{
  "collect": [{ "key": "collect", "value": "采集", "label": "采集" }],
  "condition": [{ "key": "condition:prematch:0", "value": "组名", "label": "盘前 · 组名", "bucket": "prematch", "groupIndex": 0 }],
  "betting": [{ "key": "betting:inplay:0", "value": "组名", "label": "盘中 · 组名", "bucket": "inplay", "groupIndex": 0 }]
}
```

条件/投注选项来自引擎后台已配置的分组；无分组时列表为空。

---

## 7. 常用错误码

| code | 含义 |
|------|------|
| `INVALID_API_KEY` | 缺少或无效 API Key |
| `JOB_NOT_FOUND` / `RUN_NOT_FOUND` | 任务或运行记录不存在 |
| `SCHEDULER_*_FAILED` | 调度相关失败 |
| `COLLECT_*` / `CONDITION_*` / `BETTING_*` | 对应引擎接口失败 |
| （HTTP 400）投注账号不存在 | `userAccount` 在 users 表无匹配 |
| `ENGINE_OFF`（业务跳过时多在 run 的 message） | 引擎总开关关闭导致 skipped |

---

## 8. 鉴权对照

| | `/api/engine/*` | `/api/admin/tennis-monitor/engines` | `/api/admin/scheduler/*` · API Key 管理 |
|--|-----------------|-------------------------------------|----------------------------------------|
| 鉴权 | API Key | 管理员 JWT | 管理员 JWT |
| 条件/投注 | 只读 + 触发扫描 | **完整设置（开关/分组/邮箱）** | — |
| 调度任务 | CRUD + 立即执行 | — | 网页同能力 |
| 角色 | 不校验 | 仅 admin | 仅 admin |

管理员 JWT：先 `POST /api/auth/login` 取得 `token`。  
API Key：后台「引擎 API Key」页生成，明文仅创建时显示一次。

---

## 9. 测试环境示例

```text
http://46.250.163.215:9018/api/engine/collect/status
http://46.250.163.215:9018/api/admin/tennis-monitor/engines
```

```bash
export KEY='eng_你的密钥'
curl -s -H "X-Api-Key: $KEY" \
  http://46.250.163.215:9018/api/engine/condition/status

# 条件/投注设置需管理员 JWT
export ADMIN_JWT='登录后的 token'
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  http://46.250.163.215:9018/api/admin/tennis-monitor/engines
```
