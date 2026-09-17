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
6. [错误码约定](#6-错误码约定)
7. [完整调用样例](#7-完整调用样例)

---

## 1. 鉴权说明

| 接口类型 | 鉴权方式 |
|----------|----------|
| 健康检查 | 无需登录 |
| 采集数据（盘前 / 盘中 / 盘后） | **无需 JWT**，公开读 Redis 快照 |
| 单场 / 批量 买入 / 卖出 | **无需 JWT**；请求体带 `email`（= `users.account`）定位钱包 |

共性：

- Header：`Content-Type: application/json`（POST 时）
- **不要**带 `Authorization`（本文件所列接口均不需要 JWT）
- `email` 须为已注册账号；也可用字段名 `account`
- `simulate=false` 时该用户须已配置可用钱包；`simulate=true` 可跳过
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
| 盘中 | 进行中 | `GET /api/tennis-inplay/today` |
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

### 3.2 盘中 · `GET /api/tennis-inplay/today`

```bash
curl -s 'https://www.yuce.bid/api/tennis-inplay/today'
```

场次主要在 `live.matches`，常见多比分：

```json
{
  "ok": true,
  "source": "tennis-collect-live",
  "events": 1,
  "live": {
    "eventCount": 1,
    "matches": [
      {
        "id": 12345679,
        "status": "2nd set",
        "statusType": "inprogress",
        "scoreText": "6-4 3-2",
        "home": "Player A",
        "away": "Player B",
        "homePlayer": { "id": 1, "name": "Player A", "rank": 20 },
        "awayPlayer": { "id": 2, "name": "Player B", "rank": 55 },
        "startTimestamp": 1758060000
      }
    ]
  }
}
```

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
| POST | `/api/tennis-prematch/trade/batch` | 盘前批量买入 |
| POST | `/api/tennis-inplay/trade/batch` | 盘中批量买入 |
| POST | `/api/tennis-prematch/trade/sell` | 盘前单场卖出 |
| POST | `/api/tennis-inplay/trade/sell` | 盘中单场卖出 |

共性：

- Header：`Content-Type: application/json`
- Body 必填 **`email`**（或 `account`）定位用户
- 实盘需已配置钱包；`simulate: true` 走模拟
- 虚拟采集（docks500）时强制模拟

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

## 6. 错误码约定

| HTTP | 典型场景 |
|------|----------|
| 200 | 业务结果（单场/批量条目可能 `ok: false`） |
| 400 | 参数错误 / 未配钱包 / 批量超限 |
| 404 | 邮箱用户不存在 |
| 500 | 服务端异常 |

优先看响应体里的 `ok` / `error`（批量看 `results[]`）。

---

## 7. 完整调用样例

### 7.1 读盘前 → 邮箱单场模拟买入

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

### 7.2 邮箱批量买入两场

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

### 7.3 从盘前响应取 eventId（Python）

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

## 8. 相关说明与代码

| 说明 | 内容 |
|------|------|
| 全量采集节奏 | 线上约 **每 6 小时** 一次（crontab Top100 collect） |
| 进行中刷新 | `collect_live` / inplay tick（与全量独立） |
| 邮箱下单公共逻辑 | `server/src/services/tennisOrdersPublic.js` |
| 单场 / 统一批量 | `server/src/routes/tennisOrders.js` |
| 盘前批量 | `server/src/routes/tennisPrematch.js` → `/trade/batch` |
| 盘中批量 | `server/src/routes/tennisInplay.js` → `/trade/batch` |
| 全量采集脚本 | `scripts/tennis-monitor/collect.py` |
| 进行中采集 | `scripts/tennis-monitor/collect_live.py` |

引擎调度 / API Key 见：[`引擎API对外中心-接口文档.md`](./引擎API对外中心-接口文档.md)（仍使用 API Key，与本文件无关）。
