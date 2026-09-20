# 网球定期6小时采集与线上单赛事下单 API

线上环境：[https://www.yuce.bid/](https://www.yuce.bid/)

| 项 | 值 |
|----|----|
| Base URL | `https://www.yuce.bid` |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |
| 全量采集 | 线上 cron **每 6 小时**跑一次 Top100/赛程采集（写入 Redis 三桶） |

---

## 目录

1. [鉴权说明](#1-鉴权说明)
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
| 采集数据（盘前 / 盘中 / 盘后 / 单场进行中） | **无需 JWT**，公开读 Redis 快照 |
| 单场 / 批量 / 限价 买入 / 卖出 | **无需 JWT**；请求体带 `email`（= `users.account`）定位钱包 |

共性：

- Header：`Content-Type: application/json`（POST 时）
- **不要**带 `Authorization`（本文件所列接口均不需要 JWT）
- `email` 须为已注册账号；也可用字段名 `account`
- `simulate=false` 时该用户须已配置可用钱包；`simulate=true` 可跳过
- 也可在请求体同时带 `privateKey`（或 `private_key`）和 `address`（或 `proxyAddress` / `proxy_address`）。两者都填时用这对凭证下单，不必预先保存钱包；只填一个返回 400。可选 `signatureType`（或 `signature_type`），默认 **`3`**（POLY_1271 / V2 存款钱包，新账户常用）；也可用 `0` EOA、`1` Proxy 旧、`2` Gnosis Safe。适用于本文买入 / 卖出 / 批量接口，以及 `POST /api/dota2/trade/batch`
- 虚拟采集（docks500）时服务端会**强制模拟**

> 生产环境建议限制来源 IP 或加网关密钥，避免接口被滥用。

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

线上 **每 6 小时**执行全量采集（Top100 + 赛程/赔率/Polymarket），写入 Redis；读接口只取快照，**不会在请求时再打 Sofascore**。

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
- **返回采集写入 Redis 的原始快照**，不套产品「条件组」筛选（条件筛选仅用于站内订阅页展示，不影响本接口）
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
  "serverTime": 1758100000
}
```

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

`side`：`home`（主/左）或 `away`（客/右）。

---

### 4.1 单场买入 · `POST /api/tennis/orders/buy`

#### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `email` | string | 是* | — | 用户邮箱；也可用 `account` |
| `account` | string | 是* | — | 与 `email` 二选一 |
| `product` | string | 是 | — | `tennis-prematch` / `tennis-inplay` |
| `eventId` | string/number | 是 | — | 比赛 id；也可用 `id` |
| `side` | string | 是 | — | `home` / `away` |
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
  "error": "非建议侧，禁止下单"
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
| `side` | string | 是 | — | `home` / `away` |
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
| `orders[].side` | string | 是 | `home` / `away` |
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
| `orders[].side` | string | 是 | `home` / `away` |
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
    { "ok": false, "eventId": "12345679", "error": "仅支持按建议侧下单" }
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
| `side` | string | 是 | — | `home` / `away` |
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
| `orders[].side` | string | 是 | `home` / `away` |
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
| `side` | string | 是 | — | `home` / `away` |
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
| 404 | 邮箱用户不存在 |
| 500 | 服务端异常 |

优先看响应体里的 `ok` / `error`（批量看 `results[]`）。

---

## 8. 完整调用样例

### 8.1 读单场进行中

```bash
BASE='https://www.yuce.bid'
EVENT_ID='12345679'

curl -s "$BASE/api/tennis-inplay/match/$EVENT_ID"
```

### 8.2 读盘前 → 邮箱单场模拟买入

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

### 8.3 邮箱批量买入两场

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

### 8.4 限价买入（盘前，单场）

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

### 8.5 限价卖出（盘前）

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

### 8.6 从盘前响应取 eventId（Python）

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
| 全量采集节奏 | 线上约 **每 6 小时** 一次（crontab Top100 collect） |
| 进行中刷新 | `collect_live` / inplay tick（与全量独立） |
| 邮箱下单公共逻辑 | `server/src/services/tennisOrdersPublic.js` |
| 单场 / 统一批量 | `server/src/routes/tennisOrders.js` |
| 盘前批量 / 限价 | `server/src/routes/tennisPrematch.js` → `/trade/batch` · `/trade/sell` |
| 盘中列表 / 单场 | `server/src/routes/tennisInplay.js` → `/today` · `/match/:eventId` |
| 盘中批量 / 限价 | `server/src/routes/tennisInplay.js` → `/trade/batch` · `/trade/sell` |
| 限价 CLOB | `server/src/services/polymarketTrade.js` → `placeLimitBuy` / `placeLimitSell` |
| 全量采集脚本 | `scripts/tennis-monitor/collect.py` |
| 进行中采集 | `scripts/tennis-monitor/collect_live.py` |

引擎调度 / API Key 见：[`引擎API对外中心-接口文档.md`](./引擎API对外中心-接口文档.md)（仍使用 API Key，与本文件无关）。
限价底层 REST/SDK 见：[`Polymarket限价单API说明.md`](./Polymarket限价单API说明.md)。
