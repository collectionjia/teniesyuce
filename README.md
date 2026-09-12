# teniesyuce

网球盘前 / 盘中 / 盘后采集与引擎（条件、投注、调度）及对外 API。

## 结构

| 目录 | 说明 |
|------|------|
| `client/` | Vue 前端 |
| `server/` | Node API |
| `scripts/tennis-monitor/` | 网球数据采集 |
| `btc-board/` | BTC 看板 |
| `deploy/` | Docker 测试 / 生产 env |
| `docs/` | 产品与接口说明 |

## 文档

- [盘中采集产品 · 全链路说明](docs/盘中采集产品-全链路说明.md)
- [调度中心与 API 对外中心 · 设计](docs/调度中心与API对外中心-设计.md)
- [引擎 API 对外中心 · 接口文档](docs/引擎API对外中心-接口文档.md)
- [服务器部署说明](docs/deploy-server.md)
- [网站测试用例](docs/测试用例.md)

## 本地 / Docker

```bash
# 复制并填写环境变量（勿提交）
cp server/.env.example server/.env
# 测试栈另用 server/.env.test

# 测试环境（默认 web :9018）
bash scripts/docker-deploy.sh test up -d --build

# 生产环境（默认 web :80）
bash scripts/docker-deploy.sh prod up -d --build
```

健康检查：`GET /api/health` → `{"ok":true}`

对外引擎接口前缀：`/api/engine/*`（需 API Key：`X-Api-Key` 或 `Authorization: Bearer eng_...`）。

## 仓库

https://github.com/collectionjia/teniesyuce
