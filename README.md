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

### 本机调试前端 + API（推荐，Windows）

不要用 WSL 访问 `/mnt/d/...` 跑 Vite（会很慢）。在 **PowerShell / Cursor 终端** 里：

```powershell
# 一次性：确保 client 代理指向本机 API
# client/.env.local 内容应为：
# VITE_API_PROXY_TARGET=http://127.0.0.1:3001

# 开两个窗口（API :3001 + Vite :5279）
powershell -ExecutionPolicy Bypass -File scripts/dev-local.ps1
```

或手动：

```powershell
# 窗口1
cd server; npm run dev

# 窗口2
cd client; npm run dev
```

浏览器打开 http://localhost:5279/  
`server/.env` 里的 MySQL / Redis 可继续指向 215（数据共用）；前端请求走本机 API，不再绕远端代理。

联调 215 整站时改 `client/.env.local` 为 `VITE_API_PROXY_TARGET=http://46.250.163.215:9018`，或直接打开 http://46.250.163.215:9018/ 。

### Docker 发版

```bash
# 复制并填写环境变量（勿提交）
cp server/.env.example server/.env
# 测试栈另用 server/.env.test

# 测试环境（默认 web :9018）
bash scripts/docker-deploy.sh test up -d --build

# 生产环境（默认 web :9001）
bash scripts/docker-deploy.sh prod up -d --build
```

健康检查：`GET /api/health` → `{"ok":true}`

对外引擎接口前缀：`/api/engine/*`（需 API Key：`X-Api-Key` 或 `Authorization: Bearer eng_...`）。

访问：测试 `http://IP:9018/`，生产 `http://IP:9001/`。

## 仓库

https://github.com/collectionjia/teniesyuce
