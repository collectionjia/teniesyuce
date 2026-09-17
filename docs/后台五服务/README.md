# 后台五服务拆分 · 文档索引

> 将 `server/` 内嵌的采集、规则、投注、止损、调度逻辑，拆成 **5 个独立服务**，并排于 `services/`；通过 **Redis + MySQL + HTTP 内部 API** 协作。

## 文档目录

| 文档 | 说明 |
|------|------|
| **[项目模块与实施优先级](./项目模块与实施优先级.md)** | **大模块划分 + 实现顺序（先读）** |
| [模块边界与限制](./模块边界与限制.md) | 模块职责边界、协作契约、配置/Docker/改动隔离 |
| [调度服务](./调度服务.md) | ① scheduler · 唯一定时触发（**优先级 1**） |
| [采集服务](./采集服务.md) | ② collect · 全量/部分采集 · 多 sport |
| [规则服务](./规则服务.md) | ③ rules · 未开赛/比赛中规则筛选 |
| [投注服务](./投注服务.md) | ④ betting · 按 matched 集买入 |
| [止损服务](./止损服务.md) | ⑤ stop-loss · 进行中订单全平 |

## 大项目模块（概要）

| 层 | 路径 | 说明 |
|----|------|------|
| 表现层 | `client/` | Vue 前端 |
| 网关层 | `server/`、`web/` | 业务 API、配置写入、对外 Engine API |
| **引擎层** | `services/*` | 五服务（见下） |
| 脚本层 | `scripts/tennis-monitor/` | Python 采集，归 collect 调用 |
| 基础设施 | MySQL、Redis、`deploy/` | 共用；可选 `packages/` |

## 服务实现优先级

**P0 骨架** → **① scheduler** → **② collect** → **③ rules** → **④ betting** → **⑤ stop-loss** → **P6 切流**

详见 [项目模块与实施优先级](./项目模块与实施优先级.md)。

## 目录规划

```
bbbbb/
├── client/
├── server/
├── services/
│   ├── scheduler/             # ① 9105 · 先做
│   ├── collect/               # ② 9101
│   ├── rules/                 # ③ 9102
│   ├── betting/               # ④ 9103
│   └── stop-loss/             # ⑤ 9104
├── scripts/tennis-monitor/
└── deploy/docker-compose.services.yml
```

## 数据流（简图）

```
scheduler ──HTTP──► collect ──写──► Redis 三桶
         ──HTTP──► rules   ──读/写► matched 集
         ──HTTP──► betting ──读──► matched · 写订单
         ──HTTP──► stop-loss ──读──► 订单 + inplay 比分/PM
```

## 迁移实施顺序（摘要）

| 阶段 | 优先级 | 内容 | 验收 |
|------|--------|------|------|
| **P0** | 骨架 | 五目录 + Dockerfile + health | 五端口 health 200 |
| **P1** | **① scheduler** | 调度 loop、HTTP 执行器、run 日志 | job 可触发（含 skip/stub） |
| **P2** | **② collect** | full/partial、Redis 三桶 | 与现网采集一致 |
| **P3** | **③ rules** | evaluate、matched | 同 `condition.query` |
| **P4** | **④ betting** | scan 买入、订单 | simulate 同 `bet.scan` |
| **P5** | **⑤ stop-loss** | scan 全平 | stopRules → closed |
| **P6** | 切流 | 关 server 内嵌引擎、代理 scheduler | 仅 scheduler 触发 |

完整说明 → [项目模块与实施优先级](./项目模块与实施优先级.md)

## 与现状代码映射

| 现模块 | 迁入服务 |
|--------|----------|
| `scripts/tennis-monitor/collect.py` | collect |
| `tennisCollectRunner.js` / `tennisInplayTick.js` / `tennisThreeBuckets.js` | collect |
| `tennisConditionApply.js` / `tennisEngines` condition | rules |
| `tennisBettingEngine.js` buy | betting |
| `tennisBettingEngine.js` stop | stop-loss |
| `polymarketTrade.js` / `tennisTrade.js` | betting + stop-loss |
| `schedulerLoop.js` / `schedulerRunner.js` / `schedulerStore.js` | scheduler |
| `server/routes/adminScheduler.js` | server 代理 → scheduler |

---

*文档版本：2026-09-17*
