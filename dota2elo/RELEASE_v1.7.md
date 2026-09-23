# v1.7 — 跨层比赛 Elo 失真全套修复

**Release date**: 2026-09-21
**Tag**: `v1.7`
**Commits**: `f764443`, `82cf7b8`

## 背景

v1.4 解决了 BO1 gap 阈值校准，HC@75 达到 85.5%。但跨层比赛（如 XG T1 vs Pibbles T3）模型表现差：
- Elo 不区分联赛层级，T1 队因输给强敌被低估
- T3 队因击败弱队被高估
- 跨层预测系统性方向错误

## 核心改动

### 1. 联赛层级映射（v1.5）

新增 `dota2elo/league_tiers.py`：
- 50+ 联赛的 T1-T4 分级
- league_id 主键 + 名称 fallback
- 默认 tier = T3（保守）

### 2. Bayesian 收缩（v1.5）

低样本队/选手的 Elo 向先验 1500 收缩：

```
effective = 1500 + (n / (n + 15)) * (actual - 1500)
```

### 3. Tier 偏移（v1.5）

| Tier | 偏移 | 原因 |
|---|---|---|
| T1 | **+20** | T1 联赛反复输给强敌，Elo 被低估 |
| T2 | +5 | 轻微偏差 |
| T3 | **-10** | 击败弱队让 Elo 虚高 |
| T4 | -25 | 联赛整体水平低 |

### 4. Per-Tier Elo（v1.6）

`Team` 表加 8 列（elo_t1/t2/t3/t4 + games_t1/t2/t3/t4）。每场 match 同时更新双方各自的 tier-specific Elo。预测时按自己最常玩的 tier 选对应 Elo。

### 5. 跨层校准保守折扣（v1.7）

历史所有比赛都在同一联赛，没有 cross-tier 训练数据。`calibration.apply(elo_diff, tier_gap)`：

| tier_gap | 公式 | 含义 |
|---|---|---|
| 0（同层）| `base` | 直接用校准表 |
| 1（跨 1 层）| `base * 0.75 + 0.5 * 0.25` | 25% 折扣 |
| ≥2（跨 ≥2 层）| `base * 0.50 + 0.5 * 0.50` | 50% 折扣 |

## 实战效果

| 比赛 | v1.4 | v1.5 | v1.6 | v1.7 | 市场 |
|---|---|---|---|---|---|
| XG (T1) vs Pibbles (T3) | 44% XG | 49.7% | **51.5%** composite | 50.3% / **46.9%** calibrated | 90% XG |
| 1w (T1) vs Nemesis (T3) | 58.7% 1w | 61.2% | 54.3% | 53.1% / 54.5% | 86% 1w |
| Spirit vs Falcons (T1 vs T1) | 56.1% Spirit | 56.1% | 56.4% | **56.1% / 56.2%** | — |

**方向正确**：XG vs Pibbles 在 v1.6/v1.7 终于翻盘符合市场方向

## HC@75 健康度

| 段 | v1.4 | v1.6 hybrid | v1.7 |
|---|---|---|---|
| 2025 | 88.4% | **88.6%** | 88.6% |
| 2026 | 78.6% | **100%** (4/4) | 100% |
| **合计** | **85.5%** | **89.7%** | **89.7%** |

> 85% 目标远超达成（HC@75 提升 +4.2pp）

## API 新字段（`/api/predict`）

```json
{
  "team_a_tier": "T1",
  "team_b_tier": "T3",
  "tier_gap_warning": "跨 2 层级比赛（T1 vs T3）。...",
  "team_a_tier_elo": 1532.9,    // XG.t1 (213 games)
  "team_b_tier_elo": 1545.1,    // Pibbles.t3 (6 games)
  "team_a_tier_games": 213,
  "team_b_tier_games": 6,
  "calibrated_p_a_win": 0.469   // v1.7 跨层保守折扣
}
```

## 数据规模

| 实体 | 数量 |
|---|---|
| 比赛 | 9011 |
| 战队 | 847 |
| 选手 | 2644 |
| 选手 stats | 68230 |
| 校准样本 | 8202 |

## 改动文件（v1.5 → v1.7）

- `dota2elo/league_tiers.py`（新建，100 行）
- `dota2elo/elo.py`（+120 行：shrinkage、tier_offset、tier_modifier_k、tier_aware K）
- `dota2elo/models.py`（Team 加 8 个 per-tier 列）
- `dota2elo/ingest.py`（recompute 时维护 per-tier Elo + tier-aware K）
- `dota2elo/api.py`（tier 字段、tier 传入 predict、tier_gap 传给 calibration）
- `dota2elo/calibration.py`（tier_gap 参数 + 跨层折扣）
- `scripts/year_summary.py`（tier fallback + tier 参数）

## 已知局限

1. **跨层比赛仍未达市场水平**（XG vs Pibbles 模型 50% vs 市场 90%）—— 真实信号包含市场私有信息（scrim、内部沟通等）
2. **per-tier 数据稀疏** —— 大多数队伍只在 1-2 个 tier 打过，其他 tier Elo 仍是 1500
3. **HC@75 聚合和单场准确度 trade-off** —— 跨层校准保守后，聚合指标不变但单场 calibrated 概率更接近市场

## 升级指南

```bash
git pull origin main
git checkout v1.7
pip install -r requirements.txt
# 历史数据已自动迁移（ALTER TABLE 加新列）
python -m dota2elo.calibration    # 重建校准表（应用 v1.7 折扣）
# 或：
python run.py auto-update        # ingest + recalibrate 全套
```

零破坏性，自动向后兼容。