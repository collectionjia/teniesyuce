# 五引擎服务

文档：[docs/后台五服务/](../docs/后台五服务/README.md)

## 本地开发

```powershell
# 1. 各服务安装依赖
foreach ($d in 'collect','rules','betting','stop-loss','scheduler') {
  Push-Location "services\$d"; npm install; Pop-Location
}

# 2. scheduler 配置（复制 server 数据库/Redis）
copy server\.env services\scheduler\.env
# 编辑 EXECUTOR_MODE=http 与 COLLECT_URL 等（见 scheduler/.env.example）

# 3. 一键开五个窗口 + server
powershell -File scripts/dev-all.ps1

# 仅五引擎（不含 server）
powershell -File scripts/dev-services.ps1
```

## 端口

| 服务 | 端口 |
|------|------|
| collect | 9101 |
| rules | 9102 |
| betting | 9103 |
| stop-loss | 9104 |
| scheduler | 9105 |

## 当前进度

- **P0** ✅ 五服务 health + stub internal API
- **P1** ✅ scheduler：loop、MySQL jobs/runs、HTTP 执行器、manual run
- **P2** ✅ collect：`full`（top100 / 拆三桶）、`partial`（盘中 tick，无投注）
- **P3** ✅ rules：`evaluate`、写 `tennis:rules:matched:*`、`GET matched`
- **P4** ✅ betting：读 matched → `placeBatchOrders`（simulate）、open 订单
- **P5** ✅ stop-loss：inplay open 持仓 → `runBettingPass(stop)` 全平
- **P6** ✅ server 切流：移除内嵌 scheduler/tick loop；`SCHEDULER_URL` 代理 status / 立即执行

### P6 · server 配置

在 `server/.env` 增加（与五服务同机本地 dev）：

```env
SCHEDULER_URL=http://127.0.0.1:9105
```

管理后台「立即执行」与 Engine API 调度接口经 `schedulerClient` 转发至 scheduler；**定时 loop 仅在 scheduler 进程内运行**。

### simulate 联调

```powershell
# 五服务已启动 + server/.env 已配置 DB/Redis
node scripts/test-five-services.js
```

虚拟三桶 → rules matched → betting simulate 买入 → stop-loss 扫描（未触发止损时为 `closed: 0` 属正常）。

### scheduler 手动触发

```bash
curl -X POST http://127.0.0.1:9105/internal/scheduler/run/<jobId>
```

`EXECUTOR_MODE=legacy` 时可调 server 内嵌 runner（仅本机 dev）。
