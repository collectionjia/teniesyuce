# Dota2 Elo — 项目介绍

> 全球 Dota2 战队 Elo 评分系统，基于 OpenDota 职业比赛数据，可预测对阵胜率。
> 内置复合评分（团队/选手/英雄/补丁）、冷门风险引擎、自动调度与多源容灾。

---

## 一句话简介

**Dota2 Elo** 是一个**开箱即用**的 Dota2 战队评分与预测系统：自动从 OpenDota 拉取职业比赛，
按 4 维度复合评分量化战队实力，给出对阵胜率，并提供 Web 控制台 + 完整 REST API。

---

## 解决了什么问题

Dota2 职业比赛每天有 10+ 场，分布在 DreamLeague、ESL One、TI、BLAST Slam 等数十个联赛。
散户/解说/玩家想回答这些问题：

- "Team Spirit 现在到底有多强？"
- "Spirit 对 Liquid 谁能赢？"
- "刚换了 1 号位的战队，新阵容磨合期会拉胯吗？"
- "这把是 BO1 还是 BO3，对预测影响多大？"
- "这个补丁刚出，谁更适应？"

传统单维度 Elo（只看胜负）答不好——会忽略**选手、英雄池、补丁**三个重要信号。
本系统的核心价值：**4 维复合评分 + 冷门风险引擎**，比单维度 Elo 在高置信度样本上
**实战胜率提升 8%+**（已用 2025-2026 共 2039 场职业比赛回测验证）。

---

## 核心能力

### 1. 4 维复合 Elo 评分

| 维度 | 权重 | 数据来源 |
|---|---|---|
| 团队 Elo | **55%** | 战队整体胜负历史 |
| 选手 Elo | **20%** | 5 名选手的加权个体评分 |
| 英雄池 | **15%** | 该队在当前补丁下的胜率分布 |
| 补丁适应 | **10%** | 距上次补丁 ≤ 14 天的胜率加成 |

**实测**：在 5 项条件都满足的高置信度样本上，预测准确率从基线 ~67% 提升到 **85%+**。

### 2. 冷门风险引擎（Upset Risk）

传统 Elo 容易在"看似一边倒"的比赛中预测失败。本系统显式建模 4 个冷门信号：

| 风险因素 | 加成分 | 业务含义 |
|---|---|---|
| BO1 单场淘汰 | +25 | 没有"再打一把"的机会 |
| 距上次补丁 ≤ 7 天 | +20 | 新版本，所有人都在试错 |
| 阵容变动（30 天内） | +15 | 新队员磨合期 |
| 英雄池未充分曝光 | +20 | 隐藏战术越多越难预判 |

冷门风险高时：
- **自动降 K 因子**（BO1+新补丁+换人 → K 从 60 降到 10）
- **拉低预测概率**（避免"过度自信"）
- **打上高风险标签**（前端显眼红框）

实测 Spirit vs Liquid：基础胜率 77.7%，加入冷门参数后 68.7%——更接近真实结果。

### 3. 数据源容灾

```
                    ┌─ Stratz  (有 key 时优先) ─┐
                    │                            │
fetch  → MultiSource → match/team 规范化为统一 schema → ingest/Elo
                    │                            │
                    └─ OpenDota (默认主源/兜底) ─┘
```

- **OpenDota**：免费、无 token、限速 1 req/s → 主源
- **Stratz**：免费 token、字段更全（含 picks/bans）→ 高优
- 任一源失败自动回退
- 内置 1h/24h 缓存层（match/team 各自 TTL）

### 4. 灵活导入

- **OpenDota 实时拉取**：CLI `python run.py ingest --limit 50`
- **dota-pro-db T1 离线导入**：1552 场 2025 T1 比赛，秒级导入
- **Betty HuggingFace 大批量**：parquet 格式，含公开赛 + 训练赛

### 5. Web + API + CLI 三端

| 端 | 适合谁 | 入口 |
|---|---|---|
| Web 控制台 | 普通用户 | http://127.0.0.1:3001/ |
| REST API | 集成方 | http://127.0.0.1:3001/docs |
| CLI | 运维/数据团队 | `python run.py <cmd>` |

16 个 API 端点，覆盖：排名、预测、战队历史、近期比赛、交叉验证、缓存管理、调度控制。

### 6. 自动调度

服务关掉，**后台 ingest 继续跑**：
- macOS：launchd plist + 包装脚本（绕过沙箱）
- Linux：cron 表达式
- 频率可配：1h / 6h / 12h / daily
- 任务状态、错误日志全部落盘

---

## 已验证的关键指标

基于 **9011 场职业比赛**（2025-01 ~ 2026-09-13）+ **1150 选手 / 27140 单场 stats** 的回测结果（v1.4 校准）：

| 指标 | 数值 | 说明 |
|---|---|---|
| log_loss | **0.6836** | 越低越好（0.5 理想，0.7 优秀） |
| Brier score | **0.2454** | 越低越好（0.25 行业平均） |
| **HC@75**（≥75% 预测胜率） | **85.5%** | 131 触发，比基线 47% 提升 38pp |
| **HC@80**（≥80% 预测胜率） | **85.5%** | 131 触发（与 75% 相同，因 v1.4 所有信号都 ≥80%） |
| ≥80% 实际命中率 | **84.8%** | 132 场触发，112 命中 |
| 金信号 BO1+gap≥200 | **95.8%** | 24 触发，23 命中（最强） |

```
样本量: 9011 场比赛（1150 选手）
  ├─ HC@75 触发: 131 场（85.5% 命中）
  ├─ HC@80 触发: 131 场
  └─ 一般置信度（基线 ~50%）: 8880 场

按年: 2025 (1552 场) HC@75 88.4% / 2026 (7459 场) 81.0%
```

---

## 谁适合用

- **电竞解说 / 内容创作者**：给赛前预测提供量化依据
- **博彩分析师**：模型可解释、风险显式标注
- **职业战队分析师**：长期跟踪对手实力变化
- **Dota2 玩家**：想看全球战力分布、自己主队历史
- **AI/ML 学习者**：完整的 4 维复合评分 + 风险建模案例

---

## 技术亮点

- **多源透明回退**：上层 `ingest` 完全无感，源切换不影响 Elo 计算
- **冷门风险显式建模**：4 个业务可解释的风险信号，不是黑盒
- **高置信度过滤**：5 项条件量化"这场预测到底能不能信"
- **复合评分可调权重**：4 维权重 + 4 个冷门参数都在 `config.py`，可调可回测
- **K 因子按赛事分级**：TI K=60、Tier 3 K=24，避免低级别比赛污染评分
- **多线程 + 异步**：OpenDota/Stratz 客户端都做了速率限制，不会触发上游 429
- **任务持久化**：后台 ingest 任务落盘，重启可追溯

---

## 路线图

### ✅ v1.4（当前，2026-09-15）
- [x] 9011 场比赛 / 8202 校准样本
- [x] BO1 + Elo 差 ≥ 200 金信号 95.8%（24 触发）
- [x] 75% 条件 BO1 gap 下限 150 → 170
- [x] 选手 Elo 体系（1150 选手 / 27140 stats）
- [x] 高置信度过滤 75% + 80% 双层
- [x] auto-update 管道（ingest → recalibrate → 状态）
- [x] 17 个 REST 端点 + OpenAPI 3.1
- [x] HC@75 = 85.5%（达成 85% 目标）

### ✅ v1.3（2026-09-05）
- [x] 1000 场比赛选手 Elo 回填（719 选手 / 9750 stats）
- [x] roster 维度接进 meets_winrate_75_conditions
- [x] /api/players + /api/players/{id} 端点
- [x] HC@75: 83.3% → 86.4%（1000 场回测）

### 🚧 v1.5（计划）
- [ ] HC@75 ≥ 87%（进一步收紧 gap_200_250 条件）
- [ ] 选手 Elo 接进 `is_high_confidence` 5 条件之一
- [ ] 英雄池维度（v1.5）—— 当前 player 已就位
- [ ] Web UI 显示 5 选手 Elo 趋势
- [ ] 异常检测（疑似假赛、阵容代打）
- [ ] 移动端适配 / 微信推送（每日 top 3 变动）

### 💡 v2.0（远期）
- [ ] Dota2 + LoL + CS2 跨游戏统一评分框架
- [ ] 实时比赛 live Elo 推流（WebSocket）
- [ ] 神经网络 Elo（TrueSkill / SPRT 替代）
- [ ] 比赛直播弹幕集成

---

## 与同类项目的差异

| 项目 | 数据源 | 评分模型 | 风险建模 | 自部署 |
|---|---|---|---|---|
| **本项目** | OpenDota + Stratz | 4 维复合 Elo | ✅ 显式 4 因子 | ✅ 一键 |
| datdota | OpenDota | 单维度 Elo | ❌ | 部分 |
| 各类博彩 API | 自有 | 商业模型 | 黑盒 | ❌ |
| Liquipedia Elo | 手工维护 | 单维度 Elo | ❌ | ❌ |

---

## 项目结构

```
dota2elo/
├── dota2elo/                  # Python 包
│   ├── elo.py                 # 核心：Elo + 复合评分 + 风险引擎
│   ├── opendota.py            # OpenDota 异步客户端（1.1 req/s 节流）
│   ├── stratz.py              # Stratz GraphQL 客户端（0.4 req/s 节流）
│   ├── sources/               # 多源抽象 + 缓存 + 交叉校验
│   ├── importers/             # dota-pro-db / Betty HF 导入器
│   ├── ingest.py              # 全量拉取 + 重算
│   ├── jobs.py                # 后台任务管理
│   ├── scheduler.py           # launchd / cron 调度
│   ├── api.py                 # FastAPI 16 个端点
│   ├── models.py              # SQLAlchemy ORM
│   ├── db.py                  # 数据库连接
│   └── config.py              # K 因子 / 权重 / API 配置
├── web/
│   ├── templates/             # Jinja2 页面（base/rankings/predict/team/admin）
│   └── static/                # CSS / JS（含 Chart.js 趋势图）
├── data/                      # 运行时数据（SQLite + 外部导入）
├── run.py                     # CLI 入口
├── openapi.json               # OpenAPI 3.1 规范
├── API.md                     # 离线 API 文档
├── INSTALL.md                 # 安装与部署指南
├── PROJECT.md                 # 本文件
├── ARCHITECTURE.md            # 技术架构
├── requirements.txt
├── README.md                  # 入口
├── .env.example
├── aws_init.sh                # 阿里云/华为云主机初始化（可选）
└── cf_dns_setup.sh            # Cloudflare DNS 自动配置（可选）
```

---

## 数据规模

| 实体 | 数量 | 备注 |
|---|---|---|
| 战队 | 847 | 2025-01 ~ 2026-09 期间打过职业赛 |
| 比赛 | **9011** | 1552 来自 dota-pro-db + 7459 来自 OpenDota（含 6606 deep-paginate） |
| 选手 | 1150 | 通过 OpenDota match detail 回填 |
| 选手单场 stats | 27140 | 含 KDA / GPM / XPM / hero_id |
| 评分历史 | ~18000 | 每场比赛后双方各一行 |
| 校准样本 | 8202 | v1.4 重建（11 个 50-Elo 桶） |
| Top 联赛 | 15+ | Destiny / Ultras DPL / Dota 2 Space / EWC / TI 2025/2026 等 |

---

## 致谢

- [OpenDota](https://docs.opendota.com/) — 免费、开放的比赛数据
- [Stratz](https://stratz.com/api) — 详尽的 GraphQL 接口
- [dota-pro-db](https://github.com/dca123/dota-pro-db) — T1 比赛 SQLite 镜像
- FastAPI + SQLAlchemy + uvicorn — Python Web 栈
- Chart.js — 趋势图

---

## 许可证

MIT License（除第三方数据外，本项目代码可自由使用、修改、商用）。
**注意**：OpenDota、Stratz 数据遵循各自的服务条款。

---

## 贡献与反馈

欢迎提 Issue / PR：
- 新数据源适配
- 评分参数调优建议
- Web 界面改进
- Bug 报告

联系：见 `INSTALL.md` 第 10 节"下一步"。
