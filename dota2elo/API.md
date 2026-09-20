# Dota2 Elo — API 文档

全球 Dota2 战队 Elo 评分 + 胜率预测系统。所有 API 都基于 FastAPI，启动后自动生成 OpenAPI 3.1 规范。

## 快速链接

| 用途 | URL |
|---|---|
| 启动服务 | `python run.py serve` |
| Swagger UI（交互式） | http://127.0.0.1:3001/docs |
| ReDoc（只读） | http://127.0.0.1:3001/redoc |
| OpenAPI JSON 规范 | http://127.0.0.1:3001/openapi.json |
| 离线 OpenAPI 规范 | [`openapi.json`](./openapi.json) |

## 启动

```bash
cd /Users/yongtao.wang/Downloads/dota2elo
source .venv/bin/activate
python run.py serve              # 默认 http://127.0.0.1:3001
python run.py serve --port 8080  # 自定义端口
```

第一次启动会创建 `data/dota2elo.db`（SQLite）。如果需要历史数据：
```bash
python run.py import-pro-db data/external/dota-pro-games.db
```

## 接口分组

所有 JSON 接口都返回 `application/json`，错误用标准 HTTP 状态码 + `{"detail": "..."}`。

### 公共查询（无需鉴权）

| Method | Path | 说明 |
|---|---|---|
| GET | [`/api/health`](#get-apihealth) | 健康检查 |
| GET | [`/api/rankings`](#get-apirankings) | 战队排行榜 |
| GET | [`/api/teams?q=...`](#get-apiteams) | 模糊搜索战队 |
| GET | [`/api/teams/{team_id}`](#get-apiteamsteam_id) | 战队详情 + Elo 历史 |
| GET | [`/api/players`](#get-apiplayers) | 选手榜（v1.3，需 backfill） |
| GET | [`/api/players/{player_id}`](#get-apiplayersplayer_id) | 选手详情（v1.3） |
| GET | [`/api/predict?a=...&b=...`](#get-apipredict) | 两队胜率预测（75% + 80% 条件 + 校准） |
| GET | [`/api/matches`](#get-apimatches) | 最近职业比赛 |
| GET | [`/api/calibration`](#get-apicalibration) | Elo 差→胜率校准表 |
| GET | [`/api/backtest`](#get-apibacktest) | 历史回测指标 |

### 管理（建议加鉴权）

| Method | Path | 说明 |
|---|---|---|
| POST | [`/api/admin/recompute`](#post-apirecompute) | 全量重算 Elo |
| POST | [`/api/admin/ingest`](#post-apiingest) | 启动后台 ingest |
| GET | [`/api/admin/jobs`](#get-apijobs) | 任务列表 |
| GET | [`/api/admin/jobs/{job_id}`](#get-apijobsjob_id) | 任务详情 |
| GET | [`/api/admin/cache/stats`](#get-apicachestats) | 缓存统计 |
| POST | [`/api/admin/cache/clear`](#post-apicacheclear) | 清缓存 |
| POST | [`/api/admin/recalibrate`](#post-apirecalibrate) | 重建 Elo 校准表 |

### 页面（浏览器）

| Path | 说明 |
|---|---|
| `/` | 排行榜首页 |
| `/predict` | 胜率预测 |
| `/team/{team_id}` | 战队详情 + 趋势 |
| `/admin` | 管理后台 |

---

## 接口详情

### `GET /api/health`

健康检查。任何时候都能用，无副作用。

**响应**：
```json
{ "ok": true, "version": "0.1.0" }
```

**示例**：
```bash
curl http://127.0.0.1:3001/api/health
```

---

### `GET /api/rankings`

按当前 Elo 降序返回战队列表。

**Query 参数**：
- `limit` (int, 1–500, 默认 100)：最多返回多少支

**响应**（数组元素）：
```json
{
  "id": 7119388,
  "name": "Team Spirit",
  "tag": "TSpirit",
  "logo_url": "https://...",
  "rating": 1852.4,
  "matches_played": 220,
  "wins": 165,
  "losses": 55,
  "win_rate": 0.75,
  "last_match_at": "2026-08-24T12:08:38"
}
```

**示例**：
```bash
curl 'http://127.0.0.1:3001/api/rankings?limit=20' | jq '.[0:3]'
```

---

### `GET /api/teams`

按 name/tag/id 模糊搜索战队。

**Query 参数**：
- `q` (str, 必填, ≥1 字符)：搜索关键字

**响应**：
```json
[
  { "id": 7119388, "name": "Team Spirit", "tag": "TSpirit", "rating": 1852.4, "matches_played": 220, "wins": 165, "losses": 55 },
  { "id": 9948367, "name": "Team Spirit Academy", "tag": null, "rating": 1478.0, ... }
]
```

**示例**：
```bash
curl 'http://127.0.0.1:3001/api/teams?q=spirit'
```

---

### `GET /api/teams/{team_id}`

单队详情 + 完整 Elo 历史。

**Path 参数**：
- `team_id` (int)：战队 ID

**响应**：
```json
{
  "team": {
    "id": 7119388,
    "name": "Team Spirit",
    "tag": "TSpirit",
    "logo_url": "...",
    "rating": 1852.4,
    "matches_played": 220,
    "wins": 165,
    "losses": 55,
    "win_rate": 0.75,
    "last_match_at": "2026-08-24T12:08:38"
  },
  "history": [
    {
      "match_id": 8963790789,
      "elo_before": 1845.0,
      "elo_after": 1875.0,
      "opponent_id": 9634742,
      "result": "W",
      "k_factor": 40.0,
      "recorded_at": "2026-08-23T12:08:38"
    },
    ...
  ]
}
```

**状态码**：
- `200`：成功
- `404`：战队不存在

**示例**：
```bash
curl http://127.0.0.1:3001/api/teams/7119388 | jq '.team'
curl http://127.0.0.1:3001/api/teams/7119388 | jq '.history | length'
```

---

### `GET /api/players`

v1.3 新增。按 player Elo 排序的选手榜。**需要先跑 `python scripts/backfill_players.py --limit N` 才有数据**。

**Query 参数**：
- `limit` (int, 默认 50, 范围 1-500)：返回选手数
- `min_matches` (int, 默认 5, 范围 1-100)：最少比赛数过滤

**响应**：
```json
{
  "n_total": 1150,
  "n_qualified": 87,
  "min_matches": 5,
  "players": [
    {
      "id": 152962063,
      "name": "m1CKe",
      "elo": 1734.5,
      "matches": 178,
      "wins": 95,
      "losses": 83,
      "win_rate": 0.5337
    },
    ...
  ]
}
```

**示例**：
```bash
# Top 50 选手
curl 'http://127.0.0.1:3001/api/players?limit=50' | jq '.players[:5]'

# 至少 50 场比赛的选手
curl 'http://127.0.0.1:3001/api/players?min_matches=50' | jq '.players[:10]'
```

---

### `GET /api/players/{player_id}`

v1.3 新增。单个选手的 Elo、最近比赛数、胜率。

**路径参数**：
- `player_id` (int)：选手 ID（OpenDota account_id）

**响应**：
```json
{
  "id": 152962063,
  "name": "m1CKe",
  "elo": 1734.5,
  "matches": 178,
  "wins": 95,
  "losses": 83,
  "win_rate": 0.5337,
  "last_seen_at": "2026-09-13T10:00:00",
  "recent_match_count": 20
}
```

**示例**：
```bash
curl http://127.0.0.1:3001/api/players/152962063 | jq
```

---

### `GET /api/predict`

基于当前 Elo 预测两队胜率。

**Query 参数**：
- `a` (int, 必填)：战队 A 的 ID
- `b` (int, 必填)：战队 B 的 ID

**算法**：
```
P(A wins) = 1 / (1 + 10^((R_B - R_A) / 400))
```

**响应**：
```json
{
  "team_a_id": 7119388,
  "team_a_name": "Team Spirit",
  "team_a_rating": 1852.4,
  "team_b_id": 2163,
  "team_b_name": "Team Liquid",
  "team_b_rating": 1636.2,
  "p_a_win": 0.792,
  "p_b_win": 0.208,
  "composite_p_a_win": 0.792,
  "composite_p_b_win": 0.208,
  "composite_elo_diff": 216.2,
  "upset_adjusted_prob": 0.792,
  "is_high_confidence": false,
  "risk_points": 0,
  "risk_breakdown": {
    "new_patch_week": false,
    "favorite_roster_change": false,
    "favorite_hidden_pool": false,
    "bo1": false,
    "underdog_win_streak": false,
    "manual_extra": 0
  },
  "k_factor": 25.0,
  "last_league": "The International 2026",
  "calibrated_p_a_win": 0.671,
  "calibrated_p_b_win": 0.329,
  "elo_diff": 216.4,
  "meets_75_condition": false,
  "winrate_75_conditions": [],
  "winrate_75_best_signal": "无",
  "winrate_75_expected": 0.0
}
```

**响应字段说明**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `p_a_win` / `p_b_win` | float | 标准 logistic 期望胜率 |
| `composite_p_a_win` | float | 4 维复合评分后的胜率（v1.0 阶段等同 p_a_win） |
| `composite_elo_diff` | float | 复合评分差 |
| `upset_adjusted_prob` | float | 冷门风险调整后胜率 |
| `is_high_confidence` | bool | 是否满足 5 条高置信条件（阈值 85%） |
| `risk_points` | int | upset 风险总分（0-100） |
| `risk_breakdown` | object | 各项风险因子的命中情况 |
| `k_factor` | float | K 因子（按 series_type + league 联合） |
| `last_league` | str | A 队最近参加的联赛名 |
| `calibrated_p_a_win` ⭐ | float | **Elo 差校准后胜率**（v1.1 新增） |
| `calibrated_p_b_win` ⭐ | float | **Elo 差校准后胜率**（v1.1 新增） |
| `elo_diff` | float | 两队当前 Elo 差绝对值 |
| `meets_75_condition` ⭐ | bool | **是否满足 75% 实战胜率条件**（v1.1 新增，v1.2 阈值下调） |
| `winrate_75_conditions` ⭐ | str[] | **命中的所有条件描述**（v1.1 新增） |
| `winrate_75_best_signal` ⭐ | str | **最强信号描述**（v1.1 新增） |
| `winrate_75_expected` ⭐ | float | **最强信号对应的历史胜率**（v1.1 新增） |
| `meets_80_condition` 🔒 | bool | **是否满足 80% 高置信度条件**（v1.3 新增，比 75% 更严） |
| `winrate_80_conditions` 🔒 | str[] | **80% 条件下命中的描述**（v1.3 新增） |
| `winrate_80_best_signal` 🔒 | str | 80% 最强信号（v1.3 新增） |
| `winrate_80_expected` 🔒 | float | 80% 最强信号的历史胜率（v1.3 新增） |
| `rejected_75_conditions` 🔒 | str[] | 在 75% 触发但 80% 未触发的条件（v1.3 新增） |
| `team_a_tier` 🆕 | str | A 队联赛层级 `'T1'`/`'T2'`/`'T3'`/`'T4'`（v1.5 新增） |
| `team_b_tier` 🆕 | str | B 队联赛层级（v1.5 新增） |
| `tier_gap_warning` 🆕 | str \| null | 跨层级警告（如 `null` 或"跨 2 层级比赛…"）（v1.5 新增） |

⭐ = v1.1 新增，v1.2 调整阈值
🔒 = v1.3 新增 80% 高置信度过滤
🆕 = v1.5 新增联赛层级字段

**v1.4 75% 条件更新**（基于 9011 场职业比赛回测）：

| 条件 | 历史胜率 | 样本 | 状态 |
|---|---|---|---|
| ⭐ BO1 + Elo 差 ≥ 200 | **95.8%** | 24 | 金信号（v1.4 校准） |
| ⭐ BO1 + Elo 差 ≥ 170 | **92.9%** | 28 | v1.4 从 150 上调 |
| ⭐ Top 阵容 (roster≥1700) + Elo 差 ≥ 200 | 92%+ | (v1.3) | roster 维度 |
| ⭐ BO1 + 阵容压制 (roster 差 ≥ 250) | 90%+ | (v1.3) | roster 维度 |
| 阵容压制 (roster 差 ≥ 300) | 88%+ | (v1.3) | roster 维度 |
| Top 5 + Elo 差 ≥ 150 + 高状态 | 88.1% | 42 | v1.3 |
| Elo 差 200-250 区间 | 83.0% | 53 | v1.4 校准 |
| Top 20 + Elo 差 ≥ 200 | 81.8% | 55 | v1.4 校准 |
| 近 10 场 70% + Elo 差 ≥ 200 | 84.2% | 19 | 保留 |

**回测健康度（HC@75 = 86.4%，103 触发）**：
- 2025: 91.0%
- 2026: 77.8%（backfill 后 82.3%）
- ≥80% 预测胜率场次实际命中率 84.8%

**状态码**：
- `200`：成功
- `404`：至少一方战队不存在

**示例**：
```bash
# 先查 ID
curl 'http://127.0.0.1:3001/api/teams?q=spirit' | jq '.[0].id'   # 7119388
curl 'http://127.0.0.1:3001/api/teams?q=liquid' | jq '.[0].id'   # 2163

# 预测
curl 'http://127.0.0.1:3001/api/predict?a=7119388&b=2163' | jq
# { "team_a_name": "Team Spirit", "p_a_win": 0.792, "calibrated_p_a_win": 0.671, ... }
```

---

### `GET /api/matches`

最近职业比赛，按时间倒序。

**Query 参数**：
- `limit` (int, 1–200, 默认 50)：最多返回多少场

**响应**（数组元素）：
```json
{
  "match_id": 8963790789,
  "start_time": "2026-08-24T20:05:41",
  "league_name": "EPL Masters 2026",
  "radiant_name": "FTS",
  "dire_name": "DYNASTY",
  "radiant_team_id": 10207497,
  "dire_team_id": 10225542,
  "radiant_win": false,
  "radiant_score": 28,
  "dire_score": 26,
  "k_factor": 40.0
}
```

**示例**：
```bash
curl 'http://127.0.0.1:3001/api/matches?limit=10' | jq '.[0]'
```

---

### `POST /api/admin/recompute`

全量重算 Elo。**同步执行**，2000 场约 1–2 秒。

**响应**：
```json
{
  "teams": 112,
  "matches_processed": 2072,
  "matches_skipped": 0
}
```

**示例**：
```bash
curl -X POST http://127.0.0.1:3001/api/admin/recompute | jq
```

---

### `POST /api/admin/ingest`

启动后台 ingest 任务（拉比赛 + 补全战队元数据 + 重算 Elo）。**异步**，立即返回。

**Query 参数**：
- `source` (str, 默认 `auto`)：`auto` / `opendota` / `stratz` / `multi`
- `max_pages` (int, 1–200, 默认 20)：拉取页数
- `enrich_top_n` (int, 0–500, 默认 50)：补全元数据的战队数

**响应**：
```json
{ "job_id": "ebd6db83c428", "status": "pending" }
```

**状态码**：
- `200`：任务已创建
- `400`：`source` 非法或缺少 `STRATZ_API_KEY`

**示例**：
```bash
# 启动任务
JOB=$(curl -s -X POST 'http://127.0.0.1:3001/api/admin/ingest?source=auto&max_pages=10' | jq -r .job_id)
echo "job: $JOB"

# 查进度（轮询）
while true; do
  STATUS=$(curl -s "http://127.0.0.1:3001/api/admin/jobs/$JOB" | jq -r .status)
  echo "status: $STATUS"
  [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ] && break
  sleep 2
done

# 看结果
curl "http://127.0.0.1:3001/api/admin/jobs/$JOB" | jq '.result'
```

---

### `GET /api/admin/jobs`

最近任务列表。

**Query 参数**：
- `limit` (int, 1–100, 默认 20)

**响应**：任务对象数组，每个含 `id, source, max_pages, status, started_at, finished_at, result, error`。

---

### `GET /api/admin/jobs/{job_id}`

单任务详情。

**响应**：
```json
{
  "id": "ebd6db83c428",
  "source": "auto",
  "max_pages": 20,
  "enrich_top_n": 50,
  "status": "done",
  "started_at": "2026-08-25T07:25:49.390508",
  "finished_at": "2026-08-25T07:25:50.832173",
  "result": {
    "teams": 112,
    "matches_processed": 2072,
    "new_matches": 0,
    "teams_enriched": 50,
    "source": "opendota"
  },
  "error": null
}
```

**status 取值**：
- `pending` — 已创建未开始
- `running` — 执行中
- `done` — 完成
- `error` — 失败，`error` 字段有详情

---

### `GET /api/admin/cache/stats`

数据源缓存统计。

**响应**：
```json
{ "total": 47, "expired": 3 }
```

---

### `POST /api/admin/cache/clear`

清空数据源缓存。

**响应**：
```json
{ "cleared": 47 }
```

---

### `GET /api/calibration`

Elo 差 → 实际胜率校准表。从 2012 场职业比赛学习，平滑处理。

**响应**：
```json
{
  "loaded": true,
  "bucket_size": 50.0,
  "smoothing_window": 3,
  "bucket_count": 11,
  "buckets": [
    {
      "elo_range": "0-50",
      "elo_lo": 0,
      "elo_hi": 50,
      "sample_size": 682,
      "actual_win_rate": 0.5425,
      "raw_p_win": 0.5359,
      "calibrated_p_win": 0.5672,
      "bias": 0.0066
    }
    // ...
  ]
}
```

**字段**：
- `bucket_size`：每个桶的 Elo 宽度（默认 50）
- `smoothing_window`：跨桶平滑窗口（默认 ±3）
- `buckets[]`：每个桶的实际胜率、logistic 期望、校准后值、偏差

**示例**：
```bash
curl 'http://127.0.0.1:3001/api/calibration' | jq '.buckets[2:5]'
```

---

### `GET /api/backtest`

Elo 模型回测（log loss / Brier / reliability）。

**Query 参数**：
- `min_games` (int, 0–200, 默认 10)：双方最小比赛数过滤

**响应**：
```json
{
  "n": 2039,
  "log_loss": 0.6709,
  "brier": 0.2385,
  "high_confidence_count": 66,
  "high_confidence_rate": 0.8333,
  "reliability": [
    { "bin": "50-55%", "n": 61, "predicted": 0.525, "actual_winrate": 0.574 }
    // ...
  ]
}
```

**示例**：
```bash
curl 'http://127.0.0.1:3001/api/backtest' | jq
```

---

### `POST /api/admin/recalibrate`

从历史数据重新构建 Elo 校准表。

**响应**：
```json
{
  "ok": true,
  "matches_processed": 1908,
  "message": "校准完成，处理 1908 场比赛。预测接口已自动应用。"
}
```

**等效 CLI**：
```bash
python run.py recalibrate
```

---

## 完整调用示例

### 场景 1：找两支队伍并预测

```bash
#!/bin/bash
# 1. 找 Team Spirit 的 ID
SPIRIT_ID=$(curl -s 'http://127.0.0.1:3001/api/teams?q=spirit' | jq -r '.[0].id')

# 2. 找 Team Liquid 的 ID
LIQUID_ID=$(curl -s 'http://127.0.0.1:3001/api/teams?q=liquid' | jq -r '.[0].id')

# 3. 预测
curl -s "http://127.0.0.1:3001/api/predict?a=$SPIRIT_ID&b=$LIQUID_ID" | jq
```

### 场景 2：拉取 Top 20 排行榜到 CSV

```bash
curl -s 'http://127.0.0.1:3001/api/rankings?limit=20' \
  | jq -r '["rank","name","tag","rating","matches","wins","losses","win_rate"],
           (to_entries[] | [.key+1, .value.name, .value.tag, .value.rating, .value.matches_played, .value.wins, .value.losses, .value.win_rate])
           | @csv' > top20.csv
```

### 场景 3：触发后台更新并查结果

```bash
# 触发
RESP=$(curl -s -X POST 'http://127.0.0.1:3001/api/admin/ingest?source=auto&max_pages=5')
JOB_ID=$(echo $RESP | jq -r .job_id)
echo "started: $JOB_ID"

# 轮询
for i in {1..30}; do
  STATUS=$(curl -s "http://127.0.0.1:3001/api/admin/jobs/$JOB_ID" | jq -r .status)
  echo "[$i] $STATUS"
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then
    break
  fi
  sleep 2
done

# 看结果
curl -s "http://127.0.0.1:3001/api/admin/jobs/$JOB_ID" | jq '{status, result, error}'
```

### 场景 4：用 Python 客户端

```python
import requests

BASE = "http://127.0.0.1:3001"

# 查排行榜前 5
top5 = requests.get(f"{BASE}/api/rankings?limit=5").json()
for t in top5:
    print(f"{t['name']:<30} Elo {t['rating']}")

# 预测
a = requests.get(f"{BASE}/api/teams?q=spirit").json()[0]['id']
b = requests.get(f"{BASE}/api/teams?q=liquid").json()[0]['id']
pred = requests.get(f"{BASE}/api/predict", params={"a": a, "b": b}).json()
print(f"{pred['team_a_name']} 胜率 {pred['p_a_win']*100:.1f}%")
```

---

## 错误响应

所有错误都用标准 HTTP 状态码 + JSON body：

```json
{ "detail": "Team 99999 not found" }
```

常见状态码：
- `400` Bad Request：参数错误（如非法 source）
- `404` Not Found：资源不存在
- `422` Unprocessable Entity：参数类型/范围错误（FastAPI 自动校验）
- `500` Internal Server Error：服务端 bug

---

## 算法说明

### Elo 公式

```
E_A = 1 / (1 + 10^((R_B - R_A) / 400))
R'_A = R_A + K * (S_A - E_A)
```

`S_A ∈ {0, 0.5, 1}`：0 = 负，0.5 = 平，1 = 胜。

### K 因子分级

按比赛所在联赛级别自动取 K：

| 联赛 | K |
|---|---|
| The International | 60 |
| Major / DreamLeague / ESL One / EPICENTER / MDL | 50 |
| DPC Division I/II | 40 |
| Tier 1 其他 / ESL 系列 / IEM | 32 |
| Tier 2/3 / Minor / Qualifier | 24 |
| 默认 | 20 |
| 新战队前 10 场 | 2×K（加速收敛） |

### 性能

- 单次 `/api/predict`：< 5ms（SQLite 两次 GET）
- 单次 `/api/rankings?limit=100`：< 30ms
- `/api/admin/recompute`（2072 场）：约 1 秒
- `/api/admin/ingest`（5 页 = 500 场 + 元数据）：约 5–10 分钟（含 1 req/s 节流）

### 校准度（基于 9011 场历史，v1.4 重建）

| Elo 差 | 样本 | 实际胜率 | 校准胜率 | 偏差 |
|---|---|---|---|---|
| 0–50 | 5037 | 53.1% | 56.2% | +3.1% |
| 50–100 | 2027 | 58.3% | 59.1% | +0.8% |
| 100–150 | 830 | 68.3% | 62.4% | −5.9% |
| 150–200 | 229 | 71.2% | 64.0% | −7.2% |
| 200–250 | 73 | 84.9% | 70.1% | −14.8% |
| 250–300 | 6 | 83.3% | 74.8% | −8.5% |

### HC@75 健康度（v1.4，9011 场）

| 段 | 触发 | 命中 | WR |
|---|---|---|---|
| 2025 (1552 场) | 69 | 61 | **88.4%** |
| 2026 (7459 场) | 63 | 51 | **81.0%** |
| **合计** | **132** | **112** | **84.8%** |

金信号（bo1_gap200）30 场 96.7%。详见 `scripts/year_summary.py` 输出。

---

## 数据源

| 源 | 类型 | 启用条件 | 限制 |
|---|---|---|---|
| OpenDota | REST | 默认 | ~1 req/s 礼貌速率 |
| Stratz | GraphQL | 设 `STRATZ_API_KEY` | 免费 2500 req/天 |
| dota-pro-db | SQLite | `import-pro-db <path>` | 周更 T1 比赛 |

---

## 客户端 SDK

官方无 SDK。OpenAPI 规范（`openapi.json`）可以配合以下工具自动生成：

- **TypeScript / JavaScript**：[openapi-typescript](https://openapi-ts.dev) / [openapi-generator](https://openapi-generator.tech)
- **Python**：[openapi-python-client](https://github.com/openapi-generators/openapi-python-client) / `urllib.request` 手写
- **Go**：[oapi-codegen](https://github.com/oapi-codegen/oapi-codegen)
- **Postman / Insomnia**：导入 OpenAPI JSON 直接生成测试集合

---

## 鉴权

当前所有管理接口都**未鉴权**。如果部署到公网，建议：
- 反向代理层加 Basic Auth / OAuth（nginx / Caddy）
- 或者在 `dota2elo/api.py` 里加 `Depends(verify_token)` 依赖

代码中预留了 tag 分类（`["管理"]`），未来可统一加鉴权。

---

## 版本

- API 版本：`0.1.0`（跟随代码版本）
- 兼容策略：v0.x 内可能小改；v1.0 起会保持向后兼容
- 升级时检查 `/openapi.json` 的 `info.version` 字段

### v1.4 更新日志（2026-09-15）

- 数据：9011 场比赛（OpenDota deep-paginate 增量 6606）
- 校准：8202 样本重建（之前 2205）
- 75% 条件：`BO1 + Elo 差 ≥ 150` 上调到 `≥ 170`（实际命中率从 64% 升到 92%）
- HC@75：80.0% → 85.5%（131 触发）
- 新增：`/api/players`、`/api/players/{player_id}` 已在 v1.3 引入
