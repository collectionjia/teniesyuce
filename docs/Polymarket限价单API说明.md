# Polymarket 限价单 API 说明

官方文档：

- [Place Orders](https://docs.polymarket.com/trading/place-orders)
- [POST /order API Reference](https://docs.polymarket.com/api-reference/trade/post-a-new-order)
- [Authentication](https://docs.polymarket.com/trading/authentication)
- [Rate Limits](https://docs.polymarket.com/api-reference/rate-limits)

| 项 | 值 |
|----|----|
| CLOB Base URL | `https://clob.polymarket.com` |
| 数据格式 | JSON |
| SDK（TypeScript） | `@polymarket/clob-client-v2` |
| SDK（Python） | `py_clob_client_v2` |

---

## 目录

1. [概述](#1-概述)
2. [订单类型](#2-订单类型)
3. [SDK 挂限价单](#3-sdk-挂限价单)
4. [REST 直接调用](#4-rest-直接调用)
5. [认证与签名](#5-认证与签名)
6. [相关接口](#6-相关接口)
7. [限制与注意事项](#7-限制与注意事项)
8. [与本项目现状对比](#8-与本项目现状对比)

---

## 1. 概述

**Polymarket 有挂限价单的接口。**

所有订单在 CLOB 上本质上都是限价单；所谓「市价单」也是通过提交一个可立即成交的限价单来实现。

| 方式 | 端点 / 方法 | 用途 |
|------|-------------|------|
| REST 单笔 | `POST /order` | 提交一笔限价单 |
| REST 批量 | `POST /orders` | 批量提交 |
| SDK | `createAndPostOrder()` | 创建、签名、提交一步完成 |
| SDK 分步 | `createOrder()` + `postOrder()` | 先签名再提交 |

---

## 2. 订单类型

| 类型 | 全称 | 行为 | 适用场景 |
|------|------|------|----------|
| **GTC** | Good Till Cancelled | 一直挂在 orderbook，直到成交或手动取消 | 常规挂限价单 |
| **GTD** | Good Till Date | 到指定 Unix 时间（秒）过期 | 赛事开始前自动撤单等 |
| **FOK** | Fill or Kill | 必须立即全部成交，否则整单取消 | 市价即时成交（本项目当前用法） |

### GTD 过期时间规则

- 请求里的 `expiration` 为 Unix 时间戳（秒）
- 过期时间至少要比当前时间 **晚 3 分钟**，否则会被拒单
- 系统会在 stated expiration 的 **1 分钟前** 自动过期（安全阈值）
- 若要有效存活 N 秒，应设 `expiration = now + 60 + N`

### Post-Only

在 GTC / GTD 请求中可加 `postOnly: true`：只做 maker，若会立即吃单则拒单。

---

## 3. SDK 挂限价单

### 3.1 TypeScript

```typescript
import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";

// GTC：一直挂着
const gtc = await client.createAndPostOrder(
  {
    tokenID: "TOKEN_ID",
    price: 0.50,
    size: 10,
    side: Side.BUY,
  },
  {
    tickSize: "0.01",
    negRisk: false,
  },
  OrderType.GTC
);

console.log("Order ID:", gtc.orderID);
console.log("Status:", gtc.status);
```

```typescript
// GTD：指定过期时间
const gtd = await client.createAndPostOrder(
  {
    tokenID: "TOKEN_ID",
    price: 0.45,
    size: 20,
    side: Side.SELL,
    expiration: Math.floor(Date.now() / 1000) + 3600, // 约 1 小时后过期
  },
  {
    tickSize: "0.01",
    negRisk: false,
  },
  OrderType.GTD
);
```

### 3.2 Python

```python
from py_clob_client_v2 import OrderArgs, OrderType, PartialCreateOrderOptions
from py_clob_client_v2.order_builder.constants import BUY

response = client.create_and_post_order(
    OrderArgs(
        token_id="TOKEN_ID",
        price=0.50,
        size=10,
        side=BUY,
    ),
    PartialCreateOrderOptions(tick_size="0.01", neg_risk=False),
    order_type=OrderType.GTC,
)
```

### 3.3 分步提交

```typescript
const signed = await client.createOrder(
  { tokenID, price, size, side: Side.BUY },
  { tickSize: "0.01", negRisk: false }
);
const result = await client.postOrder(signed, OrderType.GTC);
```

---

## 4. REST 直接调用

### 4.1 提交限价单

```http
POST https://clob.polymarket.com/order
Content-Type: application/json
POLY_ADDRESS: 0x...
POLY_API_KEY: ...
POLY_PASSPHRASE: ...
POLY_SIGNATURE: ...
POLY_TIMESTAMP: ...
```

请求体示例（GTC）：

```json
{
  "order": {
    "maker": "0x1234567890123456789012345678901234567890",
    "signer": "0x1234567890123456789012345678901234567890",
    "taker": "0x0000000000000000000000000000000000000000",
    "tokenId": "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    "makerAmount": "10000000",
    "takerAmount": "20000000",
    "side": "BUY",
    "expiration": "0",
    "nonce": "0",
    "feeRateBps": "0",
    "signature": "0x...",
    "salt": 123456789
  },
  "owner": "API_KEY_UUID",
  "orderType": "GTC"
}
```

GTD 示例：

```json
{
  "order": { "...": "..." },
  "owner": "API_KEY_UUID",
  "orderType": "GTD"
}
```

其中 `order.expiration` 为 Unix 秒级时间戳（非 `"0"`）。

### 4.2 主要字段

| 字段 | 说明 |
|------|------|
| `tokenId` |  outcome token ID |
| `makerAmount` / `takerAmount` | 固定精度金额（6 位小数） |
| `side` | `BUY` 或 `SELL` |
| `signature` | EIP-712 签名 |
| `orderType` | 顶层：`GTC` / `GTD` / `FOK` |
| `expiration` | GTC 用 `"0"`；GTD 用 Unix 秒 |
| `postOnly` | 可选，`true` 为 post-only |

---

## 5. 认证与签名

REST 调用需 L2 认证头：

| Header | 说明 |
|--------|------|
| `POLY_ADDRESS` | 钱包地址 |
| `POLY_API_KEY` | API Key |
| `POLY_PASSPHRASE` | API Passphrase |
| `POLY_SIGNATURE` | 请求签名 |
| `POLY_TIMESTAMP` | Unix 时间戳 |

订单本身需 EIP-712 签名（`maker`, `signer`, `signature` 等）。SDK 会自动处理；直接调 REST 需自行构造。

签名类型（`signatureType`）：

| 值 | 含义 |
|----|------|
| `0` | EOA 钱包 |
| `1` | POLY_PROXY |
| `2` | GNOSIS_SAFE |
| `3` | POLY_1271 |

每个订单还需市场参数：

- `tickSize`：最小价格步长（常见 `0.01`）
- `negRisk`：是否 neg-risk 市场（可从 market info 读取）

---

## 6. 相关接口

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/order` | 单笔下单 |
| POST | `/orders` | 批量下单 |
| DELETE | `/order` | 取消单笔 |
| DELETE | `/orders` | 批量取消 |
| DELETE | `/cancel-all` | 取消全部 |
| DELETE | `/cancel-market-orders` | 取消某市场订单 |
| GET | `/data/orders` | 查询挂单 |
| GET | `/data/trades` | 查询成交 |

---

## 7. 限制与注意事项

### 7.1 价格与数量

- `price` 必须符合市场 `tick_size`
- `size` 不得低于 `min_order_size`
- 可从 `GET /markets/{condition_id}` 或 SDK `getClobMarketInfo()` 读取

### 7.2 限流（POST /order）

| 类型 | 限制 |
|------|------|
| Burst | 5,000 req / 10s |
| Sustained | 120,000 req / 10 min |

另有 per-signer token-bucket 限制，详见 [Rate Limits](https://docs.polymarket.com/api-reference/rate-limits)。

### 7.3 与市价单的区别

| | 限价单（GTC/GTD） | 市价单（FOK） |
|--|-------------------|---------------|
| 是否挂单 | 是，可留在 orderbook | 否，立即成交或失败 |
| 价格控制 | 精确指定 price | 按 orderbook 最优价 |
| 未成交部分 | GTC/GTD 继续挂着 | FOK 整单取消 |
| 典型用途 | 等更好价格、提前布局 | 即时进场/平仓 |

---

## 8. 与本项目现状对比

本项目 `server/src/services/polymarketTrade.js` 当前实现为 **FOK 市价单**，不是挂限价单：

```javascript
// 买入：createAndPostMarketOrder + OrderType.FOK
result = await client.createAndPostMarketOrder(
  { tokenID, amount, side: Side.BUY, orderType: OrderType.FOK },
  { tickSize: '0.01' },
  OrderType.FOK
);

// 卖出：同上
result = await client.createAndPostMarketOrder(
  { tokenID, amount, side: Side.SELL, orderType: OrderType.FOK },
  { tickSize: '0.01' },
  OrderType.FOK
);
```

若需在本项目增加挂限价单能力，可参考：

```javascript
result = await client.createAndPostOrder(
  {
    tokenID: String(tokenId),
    price: 0.50,
    size: 10,
    side: Side.BUY,
  },
  { tickSize: '0.01', negRisk: false },
  OrderType.GTC  // 或 OrderType.GTD + expiration
);
```

并新增：

- 查询挂单：`GET /data/orders`
- 撤单：`DELETE /order` 或 `DELETE /orders`

---

## 参考链接

- [Polymarket Docs — Place Orders](https://docs.polymarket.com/trading/place-orders)
- [Polymarket Docs — Create Order](https://docs.polymarket.com/trading/orders/create)
- [Polymarket Docs — POST /order](https://docs.polymarket.com/api-reference/trade/post-a-new-order)
- [Polymarket Docs — Authentication](https://docs.polymarket.com/trading/authentication)
- [Polymarket Docs — Rate Limits](https://docs.polymarket.com/api-reference/rate-limits)
