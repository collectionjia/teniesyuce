# 网球定期6小时采集与线上单赛事下单 API

线上环境：[https://www.yuce.bid/](https://www.yuce.bid/)

域名 SSL 不稳定时，改走生产机 IP 直连（HTTP）：[http://95.40.57.145:9001/](http://95.40.57.145:9001/)

| 项 | 值 |
|----|----|
| Base URL | `https://www.yuce.bid` |
| 直连 Base URL | `http://95.40.57.145:9001`（生产 `yuce-prod-web`，域名 SSL 不稳时用这个，路径与域名相同） |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |
| 全量采集 | 线上 cron **每 6 小时**跑一次 Top100/赛程采集（写入 Redis 三桶） |

---

## 目录

1. [鉴权说明](#1-鉴权说明)
   - [1.1 对外 API Key（/api/engine/*）](#11-对外-api-keyapiengine)
2. [健康检查](#2-健康检查)
3. [定期采集后的数据接口](#3-定期采集后的数据接口)
4. [单场赛事下单（邮箱）](#4-单场赛事下单邮箱)
5. [批量下单（邮箱）](#5-批量下单邮箱)
6. [限价单（邮箱）](#6-限价单邮箱)
7. [错误码约定](#7-错误码约定)
8. [完整调用样例](#8-完整调用样例)

---

## 1. 鉴权说明

| 接口类型 | 鉴权方式 |
|----------|----------|
| 健康检查 | 无需登录 |
| 采集数据（盘前 / 盘中 / 盘后 / 单场进行中） | **无需 JWT / Key**，公开读 Redis 快照 |
| Dota2 / NFL 盘口（`GET /markets`） | **无需 JWT / Key**，公开读 Redis；登录后附带 `placed` |
| Dota2 / NFL 手动刷新（`POST /markets/refresh`） | **无需 JWT / Key**，触发服务端重新采集 |
| 单场 / 批量 / 限价 买入 / 卖出（第 4～6 节） | **无需 JWT / Key**；请求体带 `email`（= `users.account`）定位钱包 |
| 引擎对外中心（`/api/engine/*`） | **必须**带有效 **API Key**（见 [1.1](#11-对外-api-keyapiengine)） |

### 邮箱下单（第 3～6 节）共性

- Header：`Content-Type: application/json`（POST 时）
- **不要**带 JWT 的 `Authorization: Bearer <jwt>`（本文件第 3～6 节不需要登录）
- `email` 须为已注册账号；也可用字段名 `account`
- `simulate=false` 时该用户须已配置可用钱包；`simulate=true` 可跳过
- 也可在请求体同时带 `privateKey`（或 `private_key`）和 `address`（或 `proxyAddress` / `proxy_address`）。两者都填时用这对凭证下单，不必预先保存钱包；只填一个返回 400。可选 `signatureType`（或 `signature_type`），默认 **`3`**（POLY_1271 / V2 存款钱包，新账户常用）；也可用 `0` EOA、`1` Proxy 旧、`2` Gnosis Safe。适用于本文买入 / 卖出 / 批量接口，以及 `POST /api/dota2/trade/batch`
- 虚拟采集（docks500）时服务端会**强制模拟**

> 第 4～6 节下单接口目前**不校验 API Key**，仅靠 `email` 定位用户。生产环境建议限制来源 IP；程序化调用引擎/调度请走 `/api/engine/*` 并携带 Key。

### 1.1 对外 API Key（/api/engine/*）

面向自动化脚本、外部系统的 **引擎对外中心**，路径前缀 **`/api/engine/*`**。鉴权方式：**API Key**（不看 JWT、不看用户角色）。

#### Key 格式

- 明文前缀：`eng_`
- 示例：`eng_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`
- 服务端只存 **SHA-256 哈希**，明文**仅在创建时返回一次**，之后无法再次查看

#### 生成 Key（管理员）

**方式 A · 管理后台（推荐）**

1. 使用 **admin** 账号登录 [https://www.yuce.bid/](https://www.yuce.bid/)
2. 进入 **管理中心 → 引擎 API Key**
3. 填写名称 → **创建** → **立即复制** 弹窗中的 `apiKey` 并妥善保存

**方式 B · HTTP（须 admin JWT）**

```bash
BASE='https://www.yuce.bid'
ADMIN_JWT='你的管理员登录 token'

curl -s -X POST "$BASE/api/admin/engine-api-keys" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-bot"}'
```

**响应示例**

```json
{
  "ok": true,
  "key": {
    "id": 1,
    "name": "my-bot",
    "keyPrefix": "eng_a1b2c3",
    "ownerUserId": null
  },
  "apiKey": "eng_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "note": "请立即保存 apiKey，之后无法再次查看明文"
}
```

**管理接口（均需 admin JWT，非 API Key）**

| 操作 | Method | 路径 |
|------|--------|------|
| 列表 | `GET` | `/api/admin/engine-api-keys` |
| 创建 | `POST` | `/api/admin/engine-api-keys` |
| 吊销（禁用） | `POST` | `/api/admin/engine-api-keys/:id/revoke` |
| 删除 | `DELETE` 或 `POST …/:id/delete` | `/api/admin/engine-api-keys/:id` |
| 重新启用 | `POST` | `/api/admin/engine-api-keys/:id/enable` |

#### 调用时如何带 Key

以下三种方式**任选其一**（推荐 Header）：

| 方式 | 示例 |
|------|------|
| Header（推荐） | `X-Api-Key: eng_你的密钥` |
| Bearer（仅 `eng_` 前缀） | `Authorization: Bearer eng_你的密钥` |
| Query | `?apiKey=eng_你的密钥` |

```bash
BASE='https://www.yuce.bid'
API_KEY='eng_你的密钥'

curl -s "$BASE/api/engine/collect/status" \
  -H "X-Api-Key: $API_KEY"
```

#### `/api/engine/*` 主要能力（均需 Key）

| 分类 | 示例路径 | 说明 |
|------|----------|------|
| 采集 | `GET /api/engine/collect/status` | 采集开关、三桶场次数量、最近全量/tick 运行 |
| 采集 | `GET /api/engine/collect/health` | Redis 桶可读性粗检 |
| 采集 | `POST /api/engine/collect/full/run` | 手动触发全量采集 |
| 采集 | `POST /api/engine/collect/inplay-tick/run` | 手动触发盘中 tick |
| 条件引擎 | `GET/PUT /api/engine/condition/rules` | 读/写条件规则 |
| 投注引擎 | `GET /api/engine/betting/status` | 自动投注状态 |
| 投注引擎 | `POST /api/engine/betting/scan/run` | 手动扫描下单 |
| 调度 | `GET /api/engine/scheduler/jobs` | 任务列表 |
| 调度 | `POST /api/engine/scheduler/jobs/:id/run` | 手动执行任务 |

完整路由见 `server/src/routes/engineApi.js`。响应统一形如：

```json
{
  "ok": true,
  "data": { },
  "meta": {
    "requestId": "a1b2c3d4e5f67890",
    "serverTime": "2026-09-28T23:00:00+08:00",
    "keyId": 1
  }
}
```

#### Key 鉴权错误

| HTTP | `code` | 含义 |
|------|--------|------|
| 401 | `INVALID_API_KEY` | 未带 Key、Key 无效、已吊销或已禁用 |

```json
{
  "ok": false,
  "error": "missing api key",
  "code": "INVALID_API_KEY"
}
```

#### 与本文下单 API 的关系

| 能力 | 路径 | 鉴权 |
|------|------|------|
| 读赛程 / 下单 | `/api/tennis-prematch/*`、`/api/tennis/orders/*` 等 | **邮箱**（第 3～6 节），**不需要** API Key |
| 引擎 / 调度 / 条件 / 自动投注 | `/api/engine/*` | **必须** API Key |

实现位置：`server/src/middleware/engineApiKey.js`、`server/src/services/engineApiKeys.js`。

---

## 2. 健康检查

### `GET /api/health`

```bash
curl -s 'https://www.yuce.bid/api/health'
```

```json
{ "ok": true }
```

---

## 3. 定期采集后的数据接口

线上 **每 6 小时**执行全量采集（Top100 + 赛程/赔率/Polymarket），写入 Redis 全量包并拆到盘前/盘中/盘后三桶。

除全量外，服务端后台还会：

| 后台任务 | 默认频率 | 写入范围 |
|----------|----------|----------|
| 比分刷新（Sofascore + IPWO） | 约 30s | `full` + prematch + inplay + settled（同 `eventId` 同步） |
| PM 赔率刷新（CLOB 直连） | 约 1s | 同上，同步 `polymarketByEvent` |

读接口只取 Redis 快照，**不会在请求时再打 Sofascore / Polymarket**；盘前/盘后桶中的比分与 PM 价也会随后台刷新更新，不必等下一次 6h 全量。

| 桶 | 说明 | HTTP |
|----|------|------|
| 盘前 | 未开赛 | `GET /api/tennis-prematch/today` |
| 盘中 | 进行中（列表） | `GET /api/tennis-inplay/today` |
| 盘中 | 进行中（单场） | `GET /api/tennis-inplay/match/:eventId` |
| 盘后 | 已结束 | `GET /api/tennis-settled/today` |

共性：

- Method：`GET`
- **无需 Header 鉴权**
- 无数据时仍 **HTTP 200**，`empty: true`，`events: 0`
- **返回 Redis 快照**（全量采集 + 后台比分/赔率刷新后的结果），不套产品「条件组」筛选（条件筛选仅用于站内订阅页展示，不影响本接口）
- `fetched_at`：最近一次**全量采集**时间；`score_updated_at` / `odds_updated_at` / `tick_at`：后台刷新时间（有则返回，盘前/盘后也可能出现）
- 场次**不会**因开赛/完赛自动在桶之间迁移（仍靠 6h 全量重采拆桶）；后台只同步各桶内已有同场次的字段
- 站内会员列表需条件筛选时，加查询参数 **`applyCondition=1`**（订阅页自动带上；对外 API 对接请勿传此参数）

### 3.1 盘前 · `GET /api/tennis-prematch/today`

```bash
curl -s 'https://www.yuce.bid/api/tennis-prematch/today'
```

**响应结构摘要**

```json
{
  "ok": true,
  "sport": "tennis",
  "date": "2026-09-17",
  "fetched_at": "2026-09-17T01:20:00.000Z",
  "source": "redis-prematch",
  "dataSource": "collect",
  "events": 4,
  "member": true,
  "tradeSimulate": false,
  "scheduled": {
    "tournamentCount": 2,
    "eventCount": 4,
    "tournaments": [
      {
        "name": "Guadalajara, Mexico",
        "events": [
          {
            "id": 12345678,
            "tour": "WTA",
            "level": "WTA 500",
            "home": "Sloane Stephens",
            "away": "Caroline Dolehide",
            "homePlayer": {
              "id": 111,
              "name": "Sloane Stephens",
              "rank": 169,
              "bestRank": 5
            },
            "awayPlayer": {
              "id": 222,
              "name": "Caroline Dolehide",
              "rank": 246,
              "bestRank": 41
            },
            "status": "Not started",
            "statusType": "notstarted",
            "startTimestamp": 1758067200,
            "startTime": "03:00",
            "tournament": "Guadalajara, Mexico",
            "roundLabel": "R16",
            "url": "https://www.sofascore.com/..."
          }
        ]
      }
    ]
  },
  "live": { "matches": [], "eventCount": 0 },
  "rankingsByPlayer": {
    "111": { "current": 169, "previous": 170, "best": 5 }
  },
  "oddsByEvent": {
    "12345678": {
      "full_time": {
        "home": { "decimal": 1.44 },
        "away": { "decimal": 2.75 }
      }
    }
  },
  "polymarketByEvent": {
    "12345678": {
      "home_price": 0.665,
      "away_price": 0.335,
      "url": "https://polymarket.com/..."
    }
  },
  "birthYearByPlayer": { "111": 1993 },
  "serverTime": 1758100000,
  "tick_at": "2026-09-17T08:30:05.000Z",
  "score_updated_at": "2026-09-17T08:30:00.000Z",
  "odds_updated_at": "2026-09-17T08:30:05.000Z"
}
```

> `tick_at` / `score_updated_at` / `odds_updated_at` 为可选字段：有后台刷新时出现；`fetched_at` 仍表示全量采集时间。

### 3.2 盘中列表 · `GET /api/tennis-inplay/today`

```bash
curl -s 'https://www.yuce.bid/api/tennis-inplay/today'
```

列表包含 **已过开赛时间** 的场次（盘前 / 盘中 / 盘后 Redis 桶合并去重）。每场带标识字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `pastStart` | boolean | 当前时间 ≥ `startTimestamp` |
| `inPlay` | boolean | **真正比赛中**（`statusType` 为进行中，且未结束） |

**只有 `inPlay: true` 才算「比赛中」**；`pastStart: true` 但 `inPlay: false` 表示已结束、延期未开、或状态尚未更新为进行中。

响应额外字段：`inPlayCount` = 列表中 `inPlay: true` 的场次数。

```json
{
  "ok": true,
  "source": "tennis-collect-live",
  "events": 2,
  "inPlayCount": 1,
  "live": {
    "eventCount": 2,
    "matches": [
      {
        "id": 12345679,
        "status": "2nd set",
        "statusType": "inprogress",
        "scoreText": "6-4 3-2",
        "home": "Player A",
        "away": "Player B",
        "startTimestamp": 1758060000,
        "pastStart": true,
        "inPlay": true
      },
      {
        "id": 12345680,
        "status": "Ended",
        "statusType": "finished",
        "startTimestamp": 1758050000,
        "pastStart": true,
        "inPlay": false
      }
    ]
  }
}
```

### 3.2.1 单场 · `GET /api/tennis-inplay/match/:eventId`

按比赛 ID 读取单场快照（跨 `inplay` / `prematch` / `settled` Redis 桶查找），**无需登录**。

**命中条件**：`startTimestamp` 已过 **或** `inPlay: true`。未到开赛时间则 `found: false`。

| 项 | 说明 |
|----|------|
| Method | `GET` |
| 路径 | `/api/tennis-inplay/match/{eventId}` |
| 鉴权 | 无 |
| 数据来源 | Redis 快照（不在请求时实时打 Sofascore） |
| `inPlay` | 顶层与 `event` 内均有；`true` = 真正比赛中 |
| `pastStart` | 是否已过开赛时间 |
| `bucket` | 数据来源桶：`inplay` / `prematch` / `settled` |

```bash
curl -s 'https://www.yuce.bid/api/tennis-inplay/match/12345679'
```

**找到比赛时（HTTP 200）**

```json
{
  "ok": true,
  "found": true,
  "sport": "tennis",
  "product": "tennis-inplay",
  "eventId": "12345679",
  "bucket": "inplay",
  "pastStart": true,
  "inPlay": true,
  "date": "2026-09-17",
  "fetched_at": "2026-09-17T08:30:00.000Z",
  "source": "tennis-collect-live",
  "dataSource": "collect_live",
  "serverTime": 1758100000,
  "event": {
    "id": 12345679,
    "pastStart": true,
    "inPlay": true,
    "status": "2nd set",
    "statusType": "inprogress",
    "scoreText": "6-4 3-2",
    "home": "Player A",
    "away": "Player B",
    "homePlayer": { "id": 1, "name": "Player A", "rank": 20 },
    "awayPlayer": { "id": 2, "name": "Player B", "rank": 55 },
    "startTimestamp": 1758060000,
    "tournament": "US Open",
    "roundLabel": "QF"
  },
  "rankingsByPlayer": {
    "1": { "current": 20, "previous": 21, "best": 5 },
    "2": { "current": 55, "previous": 58, "best": 12 }
  },
  "odds": {
    "full_time": {
      "home": { "decimal": 1.72 },
      "away": { "decimal": 2.10 }
    }
  },
  "polymarket": {
    "home_price": 0.58,
    "away_price": 0.42,
    "url": "https://polymarket.com/..."
  },
  "oddsByEvent": { "12345679": { "full_time": { "home": { "decimal": 1.72 }, "away": { "decimal": 2.10 } } } },
  "polymarketByEvent": { "12345679": { "home_price": 0.58, "away_price": 0.42 } },
  "birthYearByPlayer": { "1": 1995, "2": 1998 },
  "member": true,
  "tradeSimulate": false
}
```

**未找到或暂无盘中数据（仍 HTTP 200）**

```json
{
  "ok": true,
  "found": false,
  "empty": true,
  "sport": "tennis",
  "product": "tennis-inplay",
  "eventId": "12345679",
  "inPlay": false,
  "pastStart": false,
  "message": "未找到该比赛，或未到开赛时间",
  "serverTime": 1758100000
}
```

说明：

- `eventId` 与列表接口、`POST /api/tennis/orders/buy` 的 `eventId` 相同
- 对接方判断「是否比赛中」**只看 `inPlay`**，不要仅用开赛时间推断
- 已结束但已过开赛时间的场次可能返回 `found: true, inPlay: false`（来自 `settled` 桶）
- 未开赛请查 `GET /api/tennis-prematch/today`
- 对外对接**不要**传 `applyCondition=1`（站内条件筛选用）

### 3.3 盘后 · `GET /api/tennis-settled/today`

```bash
curl -s 'https://www.yuce.bid/api/tennis-settled/today'
```

已结束场次在 `live.matches`（盘后桶复用该结构），`statusType` 多为 `finished` / `ended`。

### 3.4 比赛对象常用字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number/string | **比赛 ID**，下单时的 `eventId` |
| `tour` | string | `ATP` / `WTA` |
| `level` | string | 如 `WTA 500` |
| `home` / `away` | string | 球员名 |
| `homePlayer` / `awayPlayer` | object | `id`、`name`、`rank`、`bestRank` 等 |
| `status` / `statusType` | string | 状态文案 / 类型 |
| `pastStart` | boolean | 已过开赛时间（盘中接口） |
| `inPlay` | boolean | **真正比赛中**；非 `true` 则不是进行中 |
| `startTimestamp` | number | Unix 秒 |
| `startTime` | string | 如 `"03:00"` |
| `scoreText` | string | 比分 |
| `tournament` / `roundLabel` | string | 站名 / 轮次 |
| `url` | string | Sofascore 链接（如有） |

附属字典：

| 字段 | Key | 说明 |
|------|-----|------|
| `rankingsByPlayer` | 球员 id | `current` / `previous` / `best` |
| `oddsByEvent` | 比赛 id | 全场欧赔 |
| `polymarketByEvent` | 比赛 id | `home_price` / `away_price` / `url` |
| `birthYearByPlayer` | 球员 id | 出生年 |

### 3.5 Dota2 / NFL 采集数据（Polymarket + Elo）

与网球不同，Dota2 / NFL **没有**外部推送接口；采集在服务端内部完成（Dota2 默认约 90s 循环，NFL 走调度器 `collect.nfl` / `collect.nfl_hf`），结果写入 Redis 后通过以下接口读取。

| 运动 | 读数据 | 手动刷新 | Redis Key |
|------|--------|----------|-----------|
| Dota2 | `GET /api/dota2/markets` | `POST /api/dota2/markets/refresh` | `dota2:bundle:pm` |
| NFL | `GET /api/nfl/markets` | `POST /api/nfl/markets/refresh` | `nfl:bundle:pm` |

数据源：Polymarket Gamma；Dota2 经 dota2elo 匹配/预测，NFL 经 nflelo 预测（NFL 默认只保留 48h 内开赛窗口）。

#### 3.5.1 读取盘口 · `GET /api/dota2/markets` / `GET /api/nfl/markets`

```bash
curl -s 'https://www.yuce.bid/api/dota2/markets'
curl -s 'https://www.yuce.bid/api/nfl/markets'
```

读接口只取 Redis 快照，**不会在请求时再打 Polymarket**；未采集过则返回空列表。

响应示例（字段以 Dota2 为例，NFL 结构相同，`sport` 为 `nfl`，另含 `horizonHours`）：

```json
{
  "ok": true,
  "sport": "dota2",
  "source": "polymarket-gamma",
  "fetched_at": "2026-03-27T04:00:00.000Z",
  "thresholds": { "eloDiffMin": 150, "winProbMin": 0.65 },
  "matchCount": 12,
  "matchedCount": 10,
  "edgeCount": 5,
  "hcCount": 2,
  "scanned": 20,
  "matches": [
    {
      "slug": "dota2-match-xxx",
      "title": "Team A vs Team B",
      "url": "https://polymarket.com/event/...",
      "sideA": "Team A",
      "sideB": "Team B",
      "prices": [0.62, 0.38],
      "tokenIds": ["token_a", "token_b"],
      "outcomes": ["Team A", "Team B"],
      "startMs": 1743048000000,
      "teamA": { "id": 1, "name": "Team A", "rating": 1850 },
      "teamB": { "id": 2, "name": "Team B", "rating": 1680 },
      "eloDiff": 170,
      "pA": 0.72,
      "strongProb": 0.72,
      "pickSide": "a",
      "pickName": "Team A",
      "pickTokenId": "token_a",
      "pickPrice": 0.62,
      "matched": true,
      "is_high_confidence": true,
      "passList": true,
      "passAutoBet": true,
      "directionAligned": true
    }
  ],
  "placed": [],
  "member": false
}
```

空数据：

```json
{
  "ok": true,
  "empty": true,
  "sport": "dota2",
  "matches": [],
  "matchCount": 0,
  "fetched_at": null,
  "message": "盘口尚未采集，请刷新"
}
```

`matches[]` 常用字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `slug` | string | Polymarket 赛事标识，**下单时用** |
| `tokenIds` | string[] | CLOB token，`orders[].tokenId` 来源 |
| `pickSide` | string | 模型建议侧：`a` / `b` |
| `pickTokenId` | string | 建议侧对应 token |
| `pickPrice` | number | 建议侧当前价（0～1） |
| `prices` | number[] | 两侧市价 `[a, b]` |
| `matched` | boolean | 是否成功匹配 Elo 战队/球队 |
| `is_high_confidence` | boolean | 高置信（自动投注门槛） |
| `passList` | boolean | 是否通过列表过滤阈值 |
| `directionAligned` | boolean | 模型方向是否与盘口一致 |

登录用户响应会额外带 `placed`（已下单 `slug:side` 列表）与 `member: true`。

#### 3.5.2 手动触发采集 · `POST /api/dota2/markets/refresh` / `POST /api/nfl/markets/refresh`

```bash
curl -s -X POST 'https://www.yuce.bid/api/dota2/markets/refresh'
curl -s -X POST 'https://www.yuce.bid/api/nfl/markets/refresh'
```

无请求体。成功时返回完整 bundle（同 `GET /markets`，不含 `placed` / `member`）。失败示例：

```json
{ "ok": false, "error": "collect returned empty" }
```

#### 3.5.3 Dota2 / NFL 批量下单

从 `GET /markets` 取 `slug`、`tokenIds`、`pickSide` 后，调用：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/dota2/trade/batch` | Dota2 批量买入 |
| POST | `/api/nfl/trade/batch` | NFL 批量买入 |

鉴权与网球批量相同：body 带 `email`；`simulate` / `privateKey`+`address` 规则见 [§1](#1-鉴权说明)。`orders[].side` 为 `a` 或 `b`（对应 `sideA` / `sideB`），`orders[].tokenId` 取自 `tokenIds`。

```bash
curl -s -X POST 'https://www.yuce.bid/api/dota2/trade/batch' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "simulate": true,
    "amountUsd": 5,
    "orders": [
      { "slug": "dota2-match-xxx", "side": "a", "tokenId": "token_a" }
    ]
  }'
```

单次最多 **20** 场；支持市价（`orderType: market`）与限价（`orderType: limit`，须 `shares` + `limitBuyPrice`），规则同网球 [§6](#6-限价单邮箱)。

---

## 4. 单场赛事下单（邮箱）

前缀：`/api/tennis/orders`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tennis/orders/buy` | 单场买入 |
| POST | `/api/tennis/orders/sell` | 单场卖出 |

`product` 仅允许：

| 值 | 含义 |
|----|------|
| `tennis-prematch` | 盘前 |
| `tennis-inplay` | 盘中 |

`side`：`home`（主/左）或 `away`（客/右）。**两侧都可以下单**。服务端不按排名建议侧拦截，请求里写哪一侧就买哪一侧。单场买入、单场卖出、批量、限价都按此规则。

---

### 4.1 单场买入 · `POST /api/tennis/orders/buy`

#### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `email` | string | 是* | — | 用户邮箱；也可用 `account` |
| `account` | string | 是* | — | 与 `email` 二选一 |
| `product` | string | 是 | — | `tennis-prematch` / `tennis-inplay` |
| `eventId` | string/number | 是 | — | 比赛 id；也可用 `id` |
| `side` | string | 是 | — | `home` / `away`，两侧均可，不限制建议侧 |
| `amountUsd` | number | 是 | — | 金额 USD，**≥ 1** |
| `simulate` | boolean | 否 | `false` | 模拟下单 |
| `privateKey` | string | 否 | — | 下单私钥（64 位十六进制，可带 `0x`）；也可用 `private_key`。须与地址同时填写 |
| `address` | string | 否 | — | 代理钱包地址（`0x` + 40 位十六进制）；也可用 `proxyAddress` / `proxy_address` |
| `signatureType` | number | 否 | `3` | 签名类型：`3` POLY_1271（新账户常用）、`0` EOA、`1` Proxy 旧、`2` Gnosis Safe；也可用 `signature_type` |
| `strategyKey` | string | 否 | `_` | 策略去重键 |
| `markPlaced` | boolean | 否 | `true` | 成功后标记引擎已下单 |

#### 请求样例

```bash
curl -s -X POST 'https://www.yuce.bid/api/tennis/orders/buy' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "product": "tennis-prematch",
    "eventId": "12345678",
    "side": "home",
    "amountUsd": 5,
    "simulate": true,
    "strategyKey": "demo_bot_1",
    "markPlaced": true
  }'
```

#### 成功响应

```json
{
  "ok": true,
  "email": "user@example.com",
  "userId": 12,
  "product": "tennis-prematch",
  "eventId": "12345678",
  "side": "home",
  "amountUsd": 5,
  "price": 0.665,
  "shares": 7.5188,
  "homeName": "Sloane Stephens",
  "awayName": "Caroline Dolehide",
  "orderId": "0xabc...",
  "status": "matched",
  "simulated": true,
  "markedPlaced": true,
  "takingAmount": "...",
  "makingAmount": "..."
}
```

#### 业务失败（HTTP 200，`ok: false`）

```json
{
  "ok": false,
  "email": "user@example.com",
  "userId": 12,
  "product": "tennis-prematch",
  "eventId": "12345678",
  "side": "away",
  "amountUsd": 5,
  "simulated": true,
  "markedPlaced": false,
  "error": "暂无 Polymarket 市场"
}
```

#### 参数错误（HTTP 400）

```json
{ "ok": false, "error": "amountUsd 至少为 1" }
```

```json
{ "ok": false, "error": "该用户未配置钱包" }
```

用户不存在（HTTP 404）：

```json
{ "ok": false, "error": "邮箱对应用户不存在" }
```

---

### 4.2 单场卖出 · `POST /api/tennis/orders/sell`

#### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `email` | string | 是* | — | 用户邮箱；也可用 `account` |
| `product` | string | 是 | — | `tennis-prematch` / `tennis-inplay` |
| `eventId` | string/number | 是 | — | 比赛 id |
| `side` | string | 是 | — | `home` / `away`，两侧均可，不限制建议侧 |
| `shares` | string/number | 否 | `"all"` | 份额；`"all"` 全部 |
| `simulate` | boolean | 否 | `false` | 模拟 |
| `strategyKey` | string | 否 | — | 策略键 |
| `markSold` | boolean | 否 | `true` | 成功后标记已卖出 |

#### 请求样例

```bash
curl -s -X POST 'https://www.yuce.bid/api/tennis/orders/sell' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "product": "tennis-prematch",
    "eventId": "12345678",
    "side": "home",
    "shares": "all",
    "simulate": true
  }'
```

#### 成功响应

```json
{
  "ok": true,
  "email": "user@example.com",
  "userId": 12,
  "product": "tennis-prematch",
  "eventId": "12345678",
  "side": "home",
  "orderId": "0xdef...",
  "soldShares": 7.5188,
  "price": 0.67,
  "amountUsd": 5.03,
  "status": "matched",
  "homeName": "Sloane Stephens",
  "awayName": "Caroline Dolehide",
  "simulated": true,
  "markedSold": true
}
```

---

## 5. 批量下单（邮箱）

一次提交多场（**单次最多 20 场**），每场金额相同。可用统一入口或按产品分路径：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tennis/orders/batch` | 统一批量买入（body 带 `product`） |
| POST | `/api/tennis-prematch/trade/batch` | 盘前批量买入（支持限价，见 §6） |
| POST | `/api/tennis-inplay/trade/batch` | 盘中批量买入（支持限价，见 §6） |
| POST | `/api/tennis-prematch/trade/sell` | 盘前单场卖出（支持限价，见 §6） |
| POST | `/api/tennis-inplay/trade/sell` | 盘中单场卖出（支持限价，见 §6） |

共性：

- Header：`Content-Type: application/json`
- Body 必填 **`email`**（或 `account`）定位用户
- 实盘需已配置钱包；`simulate: true` 走模拟
- 虚拟采集（docks500）时强制模拟
- 默认 `orderType` 为市价（`market` / FOK）；限价见 [§6](#6-限价单邮箱)
- `orders[].side` 为 `home` 或 `away`，两侧都可以下，不按建议侧拒绝

> 注意：统一入口 `/api/tennis/orders/buy` · `/sell` · `/batch` **当前不传限价参数**，限价请用盘前/盘中 `/trade/batch` 与 `/trade/sell`。

---

### 5.1 统一批量买入 · `POST /api/tennis/orders/batch`

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | 是* | 用户邮箱；也可用 `account` |
| `product` | string | 是 | `tennis-prematch` / `tennis-inplay` |
| `orders` | array | 是 | 场次数组，**1～20** 条 |
| `orders[].eventId` | string/number | 是 | 比赛 id；也可用 `id` |
| `orders[].side` | string | 是 | `home` / `away`，两侧均可，不限制建议侧 |
| `amountUsd` | number | 是 | **每场**金额 USD，≥ 1 |
| `simulate` | boolean | 否 | 默认 false |

#### 请求样例

```bash
curl -s -X POST 'https://www.yuce.bid/api/tennis/orders/batch' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "product": "tennis-prematch",
    "amountUsd": 5,
    "simulate": true,
    "orders": [
      { "eventId": "12345678", "side": "home" },
      { "eventId": "12345679", "side": "away" }
    ]
  }'
```

---

### 5.2 盘前批量买入 · `POST /api/tennis-prematch/trade/batch`

（盘中把路径换成 `/api/tennis-inplay/trade/batch`，无需 body 里的 `product`。）

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | 是* | 用户邮箱 |
| `orders` | array | 是 | **1～20** 条 |
| `orders[].eventId` | string/number | 是 | 比赛 id |
| `orders[].side` | string | 是 | `home` / `away`，两侧均可，不限制建议侧 |
| `amountUsd` | number | 是 | 每场 USD，≥ 1 |
| `simulate` | boolean | 否 | 默认 false |

#### 请求样例

```bash
curl -s -X POST 'https://www.yuce.bid/api/tennis-prematch/trade/batch' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "amountUsd": 5,
    "simulate": true,
    "orders": [
      { "eventId": "12345678", "side": "home" },
      { "eventId": "12345679", "side": "away" }
    ]
  }'
```

#### 成功响应样例

```json
{
  "ok": true,
  "message": "完成 2/2",
  "simulated": true,
  "amountUsd": 5,
  "email": "user@example.com",
  "userId": 12,
  "product": "tennis-prematch",
  "results": [
    {
      "ok": true,
      "eventId": "12345678",
      "side": "home",
      "homeName": "Sloane Stephens",
      "awayName": "Caroline Dolehide",
      "amountUsd": 5,
      "price": 0.665,
      "shares": 7.5188,
      "orderId": "sim_xxxx_5678",
      "status": "matched",
      "simulated": true
    },
    {
      "ok": true,
      "eventId": "12345679",
      "side": "away",
      "homeName": "Player C",
      "awayName": "Player D",
      "amountUsd": 5,
      "orderId": "sim_xxxx_5679",
      "simulated": true
    }
  ]
}
```

#### 部分失败样例

某场失败不影响其它场，该条在 `results` 里 `ok: false`：

```json
{
  "ok": true,
  "message": "完成 1/2",
  "results": [
    { "ok": true, "eventId": "12345678", "side": "home", "orderId": "sim_xxxx" },
    { "ok": false, "eventId": "12345679", "error": "暂无 Polymarket 市场" }
  ]
}
```

---

### 5.3 批量路径单场卖出 · `POST /api/tennis-prematch/trade/sell`

（盘中：`/api/tennis-inplay/trade/sell`。）

与 §4.2 类似，路径按产品区分，**同样用 email，不需要 JWT**。

#### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `email` | string | 是* | — | 用户邮箱 |
| `eventId` | string/number | 是 | — | 比赛 id |
| `side` | string | 是 | — | `home` / `away`，两侧均可，不限制建议侧 |
| `shares` | string/number | 否 | 视实现 | 份额；常用 `"all"` |
| `simulate` | boolean | 否 | `false` | 模拟 |

#### 请求样例

```bash
curl -s -X POST 'https://www.yuce.bid/api/tennis-prematch/trade/sell' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "eventId": "12345678",
    "side": "home",
    "shares": "all",
    "simulate": true
  }'
```

---

## 6. 限价单（邮箱）

在 Polymarket CLOB 上挂 **GTC**（Good Till Cancelled）限价单：按**份额 + 目标价**挂单，成交或取消前一直挂在盘口。与市价 FOK（立即全部成交否则取消）不同。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tennis-prematch/trade/batch` | 盘前限价买入（可多场，参数相同） |
| POST | `/api/tennis-inplay/trade/batch` | 盘中限价买入 |
| POST | `/api/tennis-prematch/trade/sell` | 盘前限价卖出 |
| POST | `/api/tennis-inplay/trade/sell` | 盘中限价卖出 |

共性：

- 鉴权与 §4 / §5 相同：body 带 `email`，**无需 JWT**
- `orderType` 必须为 **`limit`**（缺省或其它值走市价）
- 目标价范围：**0.01～0.99**（小数概率价，tick `0.01`）
- 成功表示**挂单已被接受**（可能尚未成交）；响应里常有 `orderId`、`status`（如 `live` / `open` / `matched`）
- `simulate: true` 时仅记账，不打 Polymarket
- `side` 为 `home` 或 `away`，两侧都可以挂单，不按建议侧拒绝

---

### 6.1 限价买入 · `POST /api/tennis-prematch/trade/batch`

（盘中把路径换成 `/api/tennis-inplay/trade/batch`。）

限价买入**按份额下单**，金额由服务端推算：`amountUsd ≈ shares × limitBuyPrice`（不再要求 body 里的 `amountUsd ≥ 1`）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | 是* | 用户邮箱；也可用 `account` |
| `orderType` | string | 是 | 固定填 **`limit`** |
| `limitBuyPrice` | number | 是* | 买入目标价 0.01–0.99；也可用 `limitPrice` |
| `limitPrice` | number | 是* | 与 `limitBuyPrice` 二选一（优先 `limitBuyPrice`） |
| `shares` | number | 是 | 买入份额，**> 0**（向下取到 0.01） |
| `orders` | array | 是 | 场次数组，**1～20** 条 |
| `orders[].eventId` | string/number | 是 | 比赛 id；也可用 `id` |
| `orders[].side` | string | 是 | `home` / `away`，两侧均可，不限制建议侧 |
| `simulate` | boolean | 否 | 默认 false |
| `amountUsd` | number | 否 | 限价时**忽略**；由份额×目标价推算 |

单场挂单时 `orders` 只放一条即可。

#### 请求样例

```bash
curl -s -X POST 'https://www.yuce.bid/api/tennis-prematch/trade/batch' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "orderType": "limit",
    "limitBuyPrice": 0.55,
    "shares": 10,
    "simulate": true,
    "orders": [
      { "eventId": "12345678", "side": "home" }
    ]
  }'
```

#### 成功响应样例

```json
{
  "ok": true,
  "message": "批量模拟下单完成：1 场已挂单",
  "simulated": true,
  "orderType": "limit",
  "email": "user@example.com",
  "userId": 12,
  "product": "tennis-prematch",
  "total": 1,
  "success": 1,
  "failed": 0,
  "results": [
    {
      "ok": true,
      "eventId": "12345678",
      "side": "home",
      "homeName": "Sloane Stephens",
      "awayName": "Caroline Dolehide",
      "amountUsd": 5.5,
      "price": 0.55,
      "shares": 10,
      "orderId": "sim_xxxx_5678",
      "status": "simulated",
      "orderType": "limit",
      "simulated": true
    }
  ]
}
```

实盘时 `orderId` 为 CLOB 订单号，`status` 多为 `live` / `open`（挂单中）或 `matched`（已成交）。

#### 参数错误（HTTP 400）

```json
{ "ok": false, "error": "限价单须填写买入目标价（0.01–0.99）" }
```

```json
{ "ok": false, "error": "限价单须填写份额" }
```

---

### 6.2 限价卖出 · `POST /api/tennis-prematch/trade/sell`

（盘中：`/api/tennis-inplay/trade/sell`。）

#### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `email` | string | 是* | — | 用户邮箱 |
| `eventId` | string/number | 是 | — | 比赛 id |
| `side` | string | 是 | — | `home` / `away`，两侧均可，不限制建议侧 |
| `orderType` | string | 是 | — | 固定填 **`limit`** |
| `limitSellPrice` | number | 是* | — | 卖出目标价 0.01–0.99；也可用 `limitPrice` |
| `limitPrice` | number | 是* | — | 与 `limitSellPrice` 二选一（优先 `limitSellPrice`） |
| `shares` | string/number | 否 | `"all"` | 卖出份额；`"all"` / 空 = 全部持仓 |
| `simulate` | boolean | 否 | `false` | 模拟 |

#### 请求样例

```bash
curl -s -X POST 'https://www.yuce.bid/api/tennis-prematch/trade/sell' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "eventId": "12345678",
    "side": "home",
    "orderType": "limit",
    "limitSellPrice": 0.70,
    "shares": 10,
    "simulate": true
  }'
```

#### 成功响应样例

```json
{
  "ok": true,
  "email": "user@example.com",
  "userId": 12,
  "product": "tennis-prematch",
  "eventId": "12345678",
  "side": "home",
  "orderId": "0xdef...",
  "soldShares": 10,
  "price": 0.70,
  "amountUsd": 7,
  "orderType": "limit",
  "status": "live",
  "homeName": "Sloane Stephens",
  "awayName": "Caroline Dolehide",
  "simulated": false
}
```

---

### 6.3 市价 vs 限价对照

| | 市价（默认） | 限价 `orderType=limit` |
|--|-------------|------------------------|
| CLOB 类型 | FOK（立即全成否则取消） | GTC（挂单直至成交/取消） |
| 买入计量 | `amountUsd`（美元） | `shares` + `limitBuyPrice` |
| 卖出计量 | `shares`（可选 `"all"`） | `shares` + `limitSellPrice` |
| 接口 | §4 / §5 均可；限价仅 §6 路径 | 仅盘前/盘中 `/trade/batch` · `/trade/sell` |
| 成功含义 | 通常已成交 | 挂单已接受（未必立刻成交） |

底层实现：`server/src/services/polymarketTrade.js` → `placeLimitBuy` / `placeLimitSell`。Polymarket 原生 REST/SDK 细节见 [`Polymarket限价单API说明.md`](./Polymarket限价单API说明.md)。

---

## 7. 错误码约定

| HTTP | 典型场景 |
|------|----------|
| 200 | 业务结果（单场/批量条目可能 `ok: false`） |
| 400 | 参数错误 / 未配钱包 / 批量超限 / 限价缺份额或目标价 |
| 401 | `/api/engine/*` 缺少或无效 API Key（`code: INVALID_API_KEY`） |
| 404 | 邮箱用户不存在 |
| 500 | 服务端异常 |

优先看响应体里的 `ok` / `error`（批量看 `results[]`）。

---

## 8. 完整调用样例

### 8.1 用 API Key 查采集状态

```bash
BASE='https://www.yuce.bid'
API_KEY='eng_你的密钥'

curl -s "$BASE/api/engine/collect/status" \
  -H "X-Api-Key: $API_KEY"
```

### 8.2 读单场进行中

```bash
BASE='https://www.yuce.bid'
EVENT_ID='12345679'

curl -s "$BASE/api/tennis-inplay/match/$EVENT_ID"
```

### 8.3 读盘前 → 邮箱单场模拟买入

```bash
BASE='https://www.yuce.bid'

curl -s "$BASE/api/tennis-prematch/today" | tee /tmp/prematch.json

curl -s -X POST "$BASE/api/tennis/orders/buy" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "product": "tennis-prematch",
    "eventId": "12345678",
    "side": "home",
    "amountUsd": 5,
    "simulate": true
  }'
```

### 8.4 邮箱批量买入两场

```bash
curl -s -X POST "$BASE/api/tennis/orders/batch" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "product": "tennis-prematch",
    "amountUsd": 5,
    "simulate": true,
    "orders": [
      { "eventId": "12345678", "side": "home" },
      { "eventId": "12345679", "side": "away" }
    ]
  }'
```

### 8.5 限价买入（盘前，单场）

```bash
curl -s -X POST "$BASE/api/tennis-prematch/trade/batch" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "orderType": "limit",
    "limitBuyPrice": 0.55,
    "shares": 10,
    "simulate": true,
    "orders": [
      { "eventId": "12345678", "side": "home" }
    ]
  }'
```

### 8.6 限价卖出（盘前）

```bash
curl -s -X POST "$BASE/api/tennis-prematch/trade/sell" \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "eventId": "12345678",
    "side": "home",
    "orderType": "limit",
    "limitSellPrice": 0.70,
    "shares": 10,
    "simulate": true
  }'
```

### 8.7 从盘前响应取 eventId（Python）

```python
import json

with open("/tmp/prematch.json", encoding="utf-8") as f:
    data = json.load(f)

events = []
for t in (data.get("scheduled") or {}).get("tournaments") or []:
    events.extend(t.get("events") or [])

if not events:
    raise SystemExit("暂无盘前比赛")

ev = events[0]
print("eventId=", ev["id"])
print("home=", ev.get("home"), "away=", ev.get("away"))
```

---

## 9. 相关说明与代码

| 说明 | 内容 |
|------|------|
| 全量采集节奏 | 线上约 **每 6 小时** 一次（调度 `collect.top100` / Node `tennisFullCollect`） |
| 比分后台刷新 | `sofaScoreBackground` → `tennisSofascore.refreshInplayScoresOnce`（默认 30s，同步写四桶） |
| PM 赔率后台刷新 | `polyOddsBackground` → `tennisPolymarket.refreshInplayOddsOnce`（默认 1s，同步写四桶） |
| 桶同步写入 | `writeScorePatches` / `writePolymarketPatches` |
| 邮箱下单公共逻辑 | `server/src/services/tennisOrdersPublic.js` |
| 单场 / 统一批量 | `server/src/routes/tennisOrders.js` |
| 盘前批量 / 限价 | `server/src/routes/tennisPrematch.js` → `/trade/batch` · `/trade/sell` |
| 盘中列表 / 单场 | `server/src/routes/tennisInplay.js` → `/today` · `/match/:eventId` |
| 盘中批量 / 限价 | `server/src/routes/tennisInplay.js` → `/trade/batch` · `/trade/sell` |
| 限价 CLOB | `server/src/services/polymarketTrade.js` → `placeLimitBuy` / `placeLimitSell` |
| Python 采集（默认关） | `scripts/tennis-monitor/collect.py` 等，`TENNIS_PYTHON_COLLECT=0` |
| Dota2 / NFL 采集与盘口 | `server/src/services/dota2PmCollect.js` → `GET/POST /api/{dota2,nfl}/markets` |
| Dota2 / NFL 批量下单 | `server/src/routes/dota2.js` · `server/src/routes/nfl.js` → `/trade/batch` |
| 内部流程说明 | [`网球数据采集流程.md`](./网球数据采集流程.md) |

引擎调度 / API Key 见：[`引擎API对外中心-接口文档.md`](./引擎API对外中心-接口文档.md)（仍使用 API Key，与本文件无关）。
限价底层 REST/SDK 见：[`Polymarket限价单API说明.md`](./Polymarket限价单API说明.md)。
