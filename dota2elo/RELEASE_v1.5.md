# v1.5 — 联赛层级感知 + 跨层比赛 Elo 失真修复

**Release date**: 2026-09-19
**Tag**: `v1.5`
**Commits**: 3 (`8c55f80`, `b3c1829`, `12ee4d3`)

## 核心改进

解决 Elo 模型在跨层级比赛上的系统性偏差（Elo 不区分联赛质量，导致 T1 队被低估、T3 队被高估）。

## 数据规模

| 实体 | 数量 |
|---|---|
| 比赛 | 9011 |
| 战队 | 847 |
| 选手 | **2644**（backfill 完成）|
| 选手 stats | **68230** |
| 校准样本 | 8202 |

## 新功能

### 1. 联赛层级映射（`league_tiers.py`）

50+ 联赛的 T1-T4 分级表：
- `PGL Wallachia`、`TI`、`ESL One`、`DreamLeague`、`EWC` → **T1**
- `EPL Masters`、`Ultras DPL`、`BLAST Slam` → **T2**
- `Destiny League`、`RES Unchained`、`Dota 2 Space League` → **T3**
- `ExitLag ChampZ`、`Streamer Battles` → **T4**
- 未知联赛默认 **T3**（保守）

### 2. Bayesian shrinkage（`apply_bayesian_shrinkage`）

低样本队/选手的 Elo 向先验 1500 收缩：

```
effective = 1500 + (n / (n + 15)) * (actual - 1500)
```

- 10 场比赛：50% 收缩（Pibbles 1559 → 1523）
- 50 场比赛：77% 保留
- 200+ 场：93% 保留（基本不变）

### 3. Tier 偏移（`tier_elo_offset`）

| Tier | 偏移 | 原因 |
|---|---|---|
| T1 | **+20** | 在 T1 联赛反复输给强敌，Elo 被低估 |
| T2 | +5 | 轻微偏差 |
| T3 | **-10** | 击败弱队让 Elo 虚高 |
| T4 | -25 | 联赛整体水平低 |

### 4. Tier-aware K（`tier_modifier_k`）

更新 Elo 时按胜方/败方层级调整：
- T1 赢 T3（gap=-2）：discount 0.5x（预期内）
- T3 赢 T1（gap=+2）：boost 1.75x（爆冷价值高）

## API 新字段（`/api/predict`）

```json
{
  "team_a_tier": "T1",
  "team_b_tier": "T3",
  "tier_gap_warning": "跨 2 层级比赛（T1 vs T3）。Elo 不区分联赛质量，建议结合 Polymarket 等市场赔率参考。",
  ...
}
```

## 实战效果

| 比赛 | 模型（v1.4） | 模型（v1.5） | 市场 |
|---|---|---|---|
| XG (T1) vs Pibbles (T3) | 44% XG | **49.7% XG** | 90% XG |
| 1w (T1) vs Nemesis (T3) | 58.7% 1w | **61.2% 1w** | 86% 1w |
| Spirit (T1) vs Falcons (T1) | 56.1% Spirit | 56.1% Spirit | — |

跨层比赛显著改善；同层比赛不变（control 验证）。

## HC@75 健康度

| 段 | v1.4 | v1.5 |
|---|---|---|
| 2025 | 88.4% | 88.4% |
| 2026 | 78.6% | 82.8% |
| **合计** | **85.5%** | **85.7%** |
| 触发数 | 131 | 133 |

> 85% 目标达成 ✓

## 改动文件

- `dota2elo/league_tiers.py`（新建，100 行）
- `dota2elo/elo.py`（+75 行：`apply_bayesian_shrinkage`、`tier_modifier_k`、`tier_elo_offset`、`tier_a/b` 参数）
- `dota2elo/api.py`（tier 字段、传 tier 给 predict）
- `dota2elo/ingest.py`（recompute 时应用 tier-aware K）

## 已知局限

- 跨层比赛改善但仍未达市场水平（XG vs Pibbles 模型 49.7% vs 市场 90%）
- **方案 8（per-tier Elo 分离）** 是真正根本解，需要 ~12 小时工作量

## 升级指南

```bash
git pull origin main
git checkout v1.5
pip install -r requirements.txt
python run.py auto-update   # 重新校准
```

零数据迁移，自动向后兼容。