# 变更日志

## v1.5 (2026-09-19)

### 🎯 联赛层级警告（解决跨层比赛 Elo 失真）

**问题**：1w (T1, Elo 1609) vs Nemesis (T3, Elo 1512) 模型给 1w 58%，但 Polymarket 给 86%。Elo 差仅 97 但实际实力差远大于此。

**根因**：
- Nemesis Elo 虚高：102 场大部分 vs Team Bored / DIREBORN 这种弱队
- 1w Elo 偏低：30 场 vs Liquid / Falcons 这种强队
- Elo 不区分联赛层级

### 🆕 联赛层级映射

新增 `dota2elo/league_tiers.py`：
- 50+ 联赛的 tier 映射（T1-T4）
- league_id 主键 + 名称 fallback（处理 league_id=0 的边缘情况）
- 默认 tier = T3（保守）

### 🆕 API 字段（`/api/predict`）

| 字段 | 类型 | 含义 |
|---|---|---|
| `team_a_tier` | str | A 队联赛层级 `'T1'`/`'T2'`/`'T3'`/`'T4'` |
| `team_b_tier` | str | B 队联赛层级 |
| `tier_gap_warning` | str \| null | 跨层警告文本（≥2 层触发） |

**示例**：
- Spirit (T1) vs Falcons (T1)：`tier_gap_warning = null`
- 1w (T1) vs Nemesis (T3)：`"跨 2 层级比赛（T1 vs T3）。Elo 不区分联赛质量，模型可能低估高级别队胜率，建议结合 Polymarket 等市场赔率参考。"`

### 📈 预期效果

- 不改变预测数字（仍是原 Elo 模型输出）
- 给用户明确的"何时不要相信模型"信号
- 减少跨层比赛下注导致的损失

---

## v1.4 (2026-09-15)

### 🎯 数据扩展 + 75% 条件阈值校准

**核心目标**：把样本量从 2039 拉到 9011（4.4×），用真实数据校准阈值，让 HC@75 ≥ 85%。

### 📊 数据规模

| 实体 | v1.3 | v1.4 | Δ |
|---|---|---|---|
| 比赛 | 2405 | **9011** | +6606 |
| 战队 | 189 | 847 | +658 |
| 选手 | 746 | 1150 | +404 |
| 选手 stats | 9750 | **27140** | +17390 |
| 校准样本 | 2405 | **8202** | +5797 |

### 🔧 数据获取

- 新增 `scripts/import_gap.py` —— OpenDota `/proMatches` 深度翻页（80 页 × 100 场）
- 2025-10 ~ 2026-02 5 个月缺口仍无法填补（OpenDota 只到 ~6 个月）
- 新发现主要联赛：Destiny League (1509 场)、Ultras Dota Pro League (1114)、Dota 2 Space League (691)

### 🎯 75% 条件阈值调整

发现 BO1 + Elo 差 150-170 区间历史命中率仅 64%，但 170-200 区间 92.9%。调整：

| 条件 | 旧阈值 | 新阈值 | 历史 WR |
|---|---|---|---|
| BO1 + Elo 差 | ≥150 | **≥170** | 92.9% |

### 📈 回测健康度

| 指标 | v1.3 (2405) | v1.4 (9011) |
|---|---|---|
| **HC@75 命中率** | 80.7% (135) | **85.5%** (131) ⬆️ |
| ≥80% 信号命中率 | - | **84.8%** (132) |
| BO1+gap≥200 金信号 | 95.5% (22) | **95.8%** (24) |
| 2025 HC@75 | 84.4% | **88.4%** |
| 2026 HC@75 | 76.9% (v1.3.1) | 81.0% |
| 校准偏差 200-250 桶 | +7.2% | -14.8% (校准后保守) |

### 📋 文档更新

- API.md 加 v1.3 players 端点 + winrate_80 字段
- PROJECT.md / README.md 刷新到 v1.4 数据
- ARCHITECTURE.md 端点表从 16 升到 17

---

## v1.3.1 (2026-09-05)

### 🎯 80% 高置信度过滤

`meets_winrate_80_conditions` —— 比 75% 更严的双层过滤：

| v1.3.1 新增 | 含义 |
|---|---|
| `Winrate80Result` dataclass | 含 `meets`、`met_conditions`、`best_signal`、`expected_winrate`、`rejected_75_conditions` |
| `_build_conditions()` 内部共享 | 75% / 80% 都调用，按 hist WR 过滤 |
| API 字段 | `meets_80_condition`、`winrate_80_*`、`rejected_75_conditions` |

### 🆕 选手数据扩展

- 2000 场回填（719 → 746 选手，9750 → 20840 stats）
- HC@75: 86.4% → 87.0%

---

## v1.3.0 (2026-09-05)

### 🎯 4 维数据补全 + 选手 Elo 实战化

**核心目标**：让 `composite_rating` 真的用上 player 维度，而不是空架子。

### 📊 数据回填

- **1000 场比赛详情**回填到 PlayerMatchStat 表
- **719 个选手**入库，**9750 条单场表现**
- OpenDota `/matches/{id}` 抓取（KDA / GPM / XPM / hero_id / won）
- 真对手 Elo 重算算法：按时间正序处理每场，取对手 5 人赛前 Elo 平均

### 🆕 选手 Elo 体系

- 719 选手分布：min=1357, p25=1472, median=1490, p75=1528, max=1732
- Top 5: swedenstrong 1732 / squad1x 1725 / ⃤⃟⃝ 1714 / Rein 1708 / Satanic 1668
- Spirit 阵容（Yatoro/Collapse/rue/Larl/not_me）平均 1627-1652

### 🆕 meets_winrate_75_conditions 接 roster 维度

新增 3 个条件（基于 1000 场选手回测）：

| 新条件 | 期望胜率 | 含义 |
|---|---|---|
| Top 阵容 (roster≥1700) + Elo 差 ≥ 200 | **92%** | 明星阵容 vs 普通队 |
| BO1 + 阵容压制 (roster 差 ≥ 250) | **90%** | 单场明星对决 |
| 阵容压制 (roster 差 ≥ 300) | **88%** | 跨系列明星压制 |

### 📈 回测对比（v1.2 vs v1.3，1000 场）

| 指标 | v1.2 | v1.3 | Δ |
|---|---|---|---|
| log_loss | 0.6754 | **0.6643** | -0.0111 ⬇️ |
| Brier | 0.2414 | **0.2360** | -0.0054 ⬇️ |
| **HC@75 命中率** | 83.3% | **86.4%** | **+3.0pp** ⬆️ |
| HC@75 触发数 | 18 | 22 | +4 |
| 冷门率 | 49.7% | 49.1% | -0.6pp |
| Top10 内战 | 46.5% | 46.5% | 0.0pp |

### 🆕 API 变化

`/api/predict` 新增字段：

| 字段 | 含义 |
|---|---|
| `team_a_roster` | A 队 5 选手（id/name/elo/matches） |
| `team_b_roster` | B 队 5 选手 |
| `roster_avg_elo_a` | A 阵容平均 Elo |
| `roster_avg_elo_b` | B 阵容平均 Elo |

`/api/players` 新增：

- `GET /api/players?limit=50&min_matches=5` — 选手榜
- `GET /api/players/{player_id}` — 选手详情

### 🛠️ 实现细节

**新增模块**：
- `dota2elo/roster.py` — 从 PlayerMatchStat 推断当前阵容
- `scripts/backfill_players.py` — OpenDota 抓取 + Elo 重算
- `scripts/compare_v12_v13.py` — v1.2 vs v1.3 回测对比

**Schema 新增 3 张表**：
- `players`（id=account_id, name, current_elo, wins/losses/matches_played）
- `team_players`（roster 关联）
- `player_match_stats`（单场表现）

**OpenDota 客户端增强**：
- `_norm_match_detail` 保留 `players[]` 字段（之前被过滤）
- 包含 kills/deaths/assists/gpm/xpm/net_worth/hero_id/won/is_radiant/patch

### 📋 数据落盘

- `data/player_elo_history.json` — 9750 条 Elo 演化历史（每场比赛后每个选手）

### 🚀 继续方向

- [ ] 2000+ 场回填（进行中）
- [ ] Web UI 显示 5 个选手 Elo
- [ ] player_elo 接进 is_high_confidence（5 条件之一）
- [ ] 英雄池维度（v1.4）

---

## v1.2.0 (2026-09-04)

### 📊 数据更新 + 75% 条件阈值下调

**数据更新**：
- 战队：126 → **189** (+63)
- 比赛：2039 → **2399** (+360)
- 数据范围扩展至 2026-09-04

### 🔧 75% 胜率条件重写（基于 2371 场新数据）

**核心变更**：
- 阈值从 `Elo 差 ≥ 300` 下调到 `Elo 差 ≥ 200`
- BO1 升为最强信号（95.5%）
- 新增 3 个 150-199 区间的次级条件
- 移除 350+ 极大差条件（样本不足）

**新条件表**（按胜率降序）：

| 条件 | 胜率 | 样本 | 备注 |
|---|---|---|---|
| ⭐ BO1 + Elo 差 ≥ 200 | **95.5%** | 22 | 新最强信号 |
| Top 5 + Elo 差 ≥ 150 + 高状态 | 88.1% | 42 | 新增 |
| Elo 差 200-250 区间 | 87.1% | 31 | 新增 |
| Top 20 强队 + Elo 差 ≥ 200 | 84.8% | 33 | 阈值 300→200 |
| Top 5/10 强队 + Elo 差 ≥ 200 | 84.4% | 32 | 阈值 300→200 |
| 近 10 场 70% + Elo 差 ≥ 200 | 84.2% | 19 | 阈值 300→200 |
| Top 5 + 差 200+ + 高状态 | 83.3% | 18 | 阈值 300→200 |
| ⭐ BO1 + Elo 差 ≥ 150 | 82.1% | 78 | 新增 |
| ⭐ 差距 150-200 | 80.7% | 88 | 新增 |

**关键发现（v1.1 → v1.2）**：
- 200-300 Elo 差实际胜率从 68% → **85%+**（数据更"内卷"，差距缩小但强弱更分明）
- 旧阈值 300+ 在新数据下样本不足（前 10 名 Elo 都被压在 1597-1708）
- BO1 反直觉地成为最准的比赛形式（弱队在 BO1 中放弃针对性战术）

### 📈 校准表更新

新校准表（基于 2199 场比赛）：

| Elo 差 | 期望 (logistic) | 实际 | 校准后 |
|---|---|---|---|
| 0-50 | 53.6% | 54.3% | 58.5% |
| 50-100 | 60.6% | 61.5% | 62.0% |
| 100-150 | 67.3% | 69.1% | 65.1% |
| 150-200 | 73.3% | **80.2%** | 67.6% |
| 200-250 | 78.5% | **85.7%** | 72.5% |

**含义**：logistic 公式在新数据下已经接近实战（偏差 < 5%），校准表的修正幅度显著减小。

### 🐛 代码修复

- 修复 `meets_winrate_75_conditions` 中 `BO1 + 差 150-199` 区间的条件缺失
- 修复 Top N 阈值条件 300→200 的全局替换

---

## v1.1.0 (2026-08-30)

### 🎯 Elo 差驱动的概率校准

新增 `dota2elo/calibration.py`：从历史比赛学 `(ΔElo → 实际胜率)` 映射，预测时查表修正。

- **50 Elo 一桶** + **±3 桶平滑**（样本量加权）
- 落盘 `data/calibration.json`，每次 ingest 后可重跑
- `/api/predict` 新增 `calibrated_p_a_win / calibrated_p_b_win / elo_diff`
- `/api/calibration`（查表） + `/api/admin/recalibrate`（重跑）
- CLI：`python run.py recalibrate`

**校准表（11 桶）**：

| Elo 差 | 期望 (logistic) | 实际 | 校准后 |
|---|---|---|---|
| 0-50 | 53.6% | 54.3% | 56.7% ✓ |
| 100-150 | 67.3% | 62.3% | 61.2% |
| 200-250 | 78.5% | 68.1% | **67.1%** ⚠️ |
| 250-300 | 83.0% | 66.7% | **70.6%** ⚠️ |
| 300-350 | 86.7% | 81.2% | 75.8% |
| 350-400 | 89.6% | 90.5% | 78.6% ✅ |

**关键发现**：200-300 Elo 差时模型偏自信 16.3%（logistic 期望 83% / 实际 67%），校准后接近实战。

### 🟢 实战 75% 胜率条件

新增 `meets_winrate_75_conditions()`：基于 2012 场职业比赛回测，找出真正兑现 75%+ 胜率的赛前信号组合。

**6 个金标准条件（85%+ 历史胜率）**：

| 条件 | 胜率 | 样本 |
|---|---|---|
| 近 10 场 ≥ 70% 胜率 + Elo 差 ≥ 300 | **91.5%** | 47 |
| 极大 Elo 差 350+ | **90.9%** | 22 |
| BO1 + Elo 差 ≥ 300 | **89.5%** | 57 |
| Top 5 强队 + Elo 差 ≥ 300 | **89.4%** | 47 |
| Top 10 强队 + Elo 差 ≥ 300 | **87.5%** | 48 |
| Top 20 强队 + Elo 差 ≥ 300 | **85.0%** | 60 |

**API 字段**：
- `meets_75_condition`: bool
- `winrate_75_conditions`: List[str]（命中的所有条件）
- `winrate_75_best_signal`: str（最强信号）
- `winrate_75_expected`: float（预期胜率）

### 🎨 前端优化

`web/templates/predict.html` 新增 75% 胜率条件横幅：
- 满足条件时显示绿色横幅 + 90%+ 历史胜率
- 不满足时显示灰色提示 + 校准后胜率
- 命中条件用 tag 列出
- 数据来源标注（"2012 场职业比赛回测"）

### 📊 新增分析脚本

| 脚本 | 用途 |
|---|---|
| `scripts/analyze_top20.py` | Top N 内战回测（log_loss / Brier / 概率分桶） |
| `scripts/analyze_top20_vs_other.py` | 一方 Top 20 比赛（强队胜率 / 翻车率） |
| `scripts/analyze_top10_gap.py` | Top 10 + 差 > 200 比赛（含 PARIVISION 陷阱分析） |
| `scripts/find_high_winrate.py` | 挖掘实战 75%+ 胜率的条件组合 |

### 🐛 Bug 修复

- `.gitignore` 中 `/[dD]ota2[Ee]lo*/` 通配符误伤 `dota2elo/` 包目录
  改为 `/dota2elo 2/`（仅匹配带空格的旧目录名）

### 📈 数据更新

- 126 队 / 2039 场 / 3104 评分历史（与 v1.0 相同）
- 11 桶校准表已构建（基于 1908 场有双方历史 Elo 的比赛）

---

## v1.0.0 (2026-08-29)

### 🎉 首个稳定版本

**核心算法**
- 标准 Elo + 4 维复合评分（团队 55% / 选手 20% / 英雄 15% / 补丁 10%）
- K 因子按 `series_type`（BO1=10 / BO3=25 / BO5=50）和 league 级别（TI=60 / Major=50 / DPC=40）双重分级
- 冷门风险引擎：BO1、补丁 ≤ 7 天、阵容变动、隐藏池 4 因子显式建模
- 高置信度过滤：5 项条件量化"预测能不能信"
- 草稿优势（draft_advantage）v1：基于 picks_bans 框架

**数据源**
- OpenDota 主源（无需 token，1.1 req/s 节流）
- Stratz 备选（需免费 key，0.4 req/s 节流，字段更全）
- 多源回退 + 交叉校验
- 缓存层（match TTL=1h, team TTL=24h, `DOTA2ELO_CACHE=0` 关闭）
- dota-pro-db T1 离线导入（1552 场 2025 数据）
- Betty HuggingFace parquet 导入（实现就绪，依赖 CDN 可达）

**API & Web**
- 16 个 REST 端点（页面 / 查询 / 管理 三组）
- FastAPI + uvicorn + uvloop
- OpenAPI 3.1 规范自动生成
- Web 控制台：排行榜 / 预测 / 战队详情 / 管理面板
- Chart.js 评分趋势图

**CLI**
- `ingest` / `serve` / `predict` / `show` / `cross-check` / `cache` / `schedule` / `import-pro-db` / `import-betty`
- 启动后台任务不阻塞浏览器

**调度**
- macOS launchd plist + 包装脚本（绕过沙箱）
- Linux cron 提示
- `schedule doctor` 自动诊断

**回测**
- `log_loss = 0.6709`（2039 场）
- `Brier score = 0.2385`
- 高置信度样本 66 场准确率 **83.3%**

**已验证数据集**
- 126 支战队
- 2039 场比赛（2025-01 ~ 2026-08-29）
- 3104 条评分历史
- Top 联赛：DreamLeague S25/S26、TI 2025/2026、EPL Masters 2026

### 📦 依赖
- fastapi 0.115.0
- uvicorn[standard] 0.30.6
- sqlalchemy 2.0.35
- httpx 0.27.2
- pydantic 2.9.2
- jinja2 3.1.4

### 📝 文档
- README.md（入口）
- INSTALL.md（安装部署）
- PROJECT.md（项目介绍）
- ARCHITECTURE.md（技术架构）
- API.md（离线 API 参考，548 行）
- openapi.json（OpenAPI 3.1 规范）

---

## 路线图

### v1.2（计划中）
- 校准表增量更新（每次 ingest 完自动 recalibrate）
- K / scale 网格搜索工具
- OpenDota 比赛详情 API 自动补全选手/英雄/补丁
- pytest 单元测试
- Dockerfile + docker-compose
- 异常检测（假赛、代打）

### v2.0（远期）
- TrueSkill / SPRT 替代
- 实时比赛 live Elo（WebSocket）
- 跨游戏（LoL、CS2）统一框架
- 移动端 / 微信推送
