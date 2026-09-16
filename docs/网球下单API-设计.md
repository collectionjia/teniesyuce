# 网球下单 API 设计

> 状态：**已实现**（`server/src/routes/tennisOrders.js`）  
> 范围：**仅单场买入、单场卖出**  
> 鉴权：**不需要登录 JWT**；用 **邮箱（账号）** 定位用户并加载其钱包。

---

## 1. 目标

| 项 | 说明 |
|----|------|
| 单场买入 / 卖出 | 一次一场 |
| 身份 | 请求体带 `email`（= `users.account`）→ 查用户 → 读该用户钱包 |
| 无 JWT | 调用方不必先登录 H5 |

> 注意：仅靠邮箱即可动用该用户钱包；生产环境建议后续加 Engine API Key。

---

## 2. 路径

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tennis/orders/buy` | 单场买入 |
| POST | `/api/tennis/orders/sell` | 单场卖出 |

现有 H5 的 `/trade/batch|sell`（JWT）**仍保留**。

---

## 3. 买入 `POST /api/tennis/orders/buy`

```json
{
  "email": "user@example.com",
  "product": "tennis-prematch",
  "eventId": "12345678",
  "side": "home",
  "amountUsd": 5,
  "simulate": false,
  "strategyKey": "sk_xxx",
  "markPlaced": true
}
```

| 参数 | 必填 | 意思 |
|------|------|------|
| `email` | 是 | 用户邮箱（也可用 `account`） |
| `product` | 是 | `tennis-prematch` / `tennis-inplay` |
| `eventId` | 是 | 比赛 id |
| `side` | 是 | `home` / `away`（仍校验建议侧） |
| `amountUsd` | 是 | ≥ 1 |
| `simulate` | 否 | 默认 false；docks500 强制模拟 |
| `strategyKey` | 否 | 去重用 |
| `markPlaced` | 否 | 默认 true |

---

## 4. 卖出 `POST /api/tennis/orders/sell`

```json
{
  "email": "user@example.com",
  "product": "tennis-inplay",
  "eventId": "12345678",
  "side": "home",
  "shares": "all",
  "simulate": false,
  "strategyKey": "sk_xxx",
  "markSold": true
}
```

| 参数 | 必填 | 意思 |
|------|------|------|
| `email` | 是 | 找用户钱包 |
| `product` | 是 | 盘前 / 盘中 |
| `eventId` | 是 | 比赛 id |
| `side` | 是 | home / away |
| `shares` | 否 | 默认 `"all"` |
| `simulate` | 否 | 默认 false |
| `strategyKey` | 否 | 策略键 |
| `markSold` | 否 | 默认 true |

---

## 5. 示例

```bash
curl -s -X POST 'http://127.0.0.1:3001/api/tennis/orders/buy' \
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

---

## 6. 代码

- `server/src/routes/tennisOrders.js`
- `server/src/index.js` 挂载 `/api/tennis/orders`
