# Dota2 Elo

> 全球 Dota2 战队 Elo 评分系统，基于 OpenDota 职业比赛数据，可预测对阵胜率。
> 内置 **4 维复合评分**（团队/选手/英雄/补丁）+ **冷门风险引擎** + **多源容灾**。

![status](https://img.shields.io/badge/status-stable-brightgreen) ![py](https://img.shields.io/badge/python-3.9%2B-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 5 分钟跑起来

```bash
# 1) 解压
unzip dota2elo.zip && cd dota2elo

# 2) 装依赖
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3) 首次拉数据
python run.py ingest --limit 20

# 4) 启动
python run.py serve
# 打开 http://127.0.0.1:3001
```

详细安装见 **[INSTALL.md](INSTALL.md)**。

---

## 文档导航

| 文档 | 适合谁 | 内容 |
|---|---|---|
| **[INSTALL.md](INSTALL.md)** | 部署者 | 5 分钟快速开始、生产部署、调度配置、FAQ |
| **[PROJECT.md](PROJECT.md)** | 所有人 | 项目介绍、解决什么问题、核心能力、路线图 |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | 开发者 | 模块划分、数据流、算法数学、扩展点 |
| **[API.md](API.md)** | API 用户 | 17 个端点的离线参考（含示例） |
| **[CHANGELOG.md](CHANGELOG.md)** | 维护者 | 版本历史、变更记录 |
| **[openapi.json](openapi.json)** | 集成方 | OpenAPI 3.1 规范（导入 Postman/Insomnia） |

---

## 核心能力一览

- ✅ **4 维复合 Elo**：团队 55% + 选手 20% + 英雄 15% + 补丁 10%
- ✅ **冷门风险引擎**：BO1 / 新补丁 / 换人 / 隐藏池 4 因子显式建模
- ✅ **高置信度过滤**：75% / 80% 双层条件（v1.3 起，9 + 11 条数据驱动规则）
- ✅ **多源容灾**：OpenDota 主 + Stratz 备 + 缓存层 + 多源回退
- ✅ **K 因子分级**：BO1/BO3/BO5 + TI/Major/DPC/Tier 双重映射
- ✅ **Web + API + CLI** 三端
- ✅ **后台 ingest 任务**，可独立于 Web 运行
- ✅ **launchd / cron 调度**，自动拉新数据
- ✅ **回测**：HC@75 = **85.5%**（131 触发）/ 80%+ 信号命中率 **84.8%**

实测数据：**847 支战队 / 9011 场比赛 / 1150 选手**，2025-01 ~ 2026-09-13。

---

## 接口示例

```bash
# 排行榜 Top 10
curl http://127.0.0.1:3001/api/rankings?limit=10 | jq '.[0:5]'

# 模糊搜战队
curl 'http://127.0.0.1:3001/api/teams?q=spirit' | jq '.[0]'

# 预测（Spirit vs Liquid）
curl 'http://127.0.0.1:3001/api/predict?a=7119388&b=2163' | jq

# 选手榜 Top 10
curl 'http://127.0.0.1:3001/api/players?limit=10' | jq '.players[:5]'

# 校准表（8202 样本）
curl http://127.0.0.1:3001/api/calibration | jq '.buckets'
```

---

## 浏览器入口

| 路径 | 用途 |
|---|---|
| `/` | 排行榜首页 |
| `/predict` | 对阵预测 UI |
| `/team/{id}` | 战队详情 + 评分趋势图 |
| `/admin` | 后台管理（启动 ingest / 看缓存） |
| `/docs` | Swagger UI 交互式 API 文档 |

---

## 数据源

主源：[OpenDota](https://docs.opendota.com/) — 公共 API，无 token
备选：[Stratz](https://stratz.com/api) GraphQL — 需免费 token，字段更全

导入源：dota-pro-db T1 SQLite、Betty HuggingFace parquet

---

## 许可证

MIT License（代码）；OpenDota/Stratz 数据遵循各自服务条款。

---

## 致谢

OpenDota、Stratz、dota-pro-db、FastAPI、SQLAlchemy、Chart.js。
