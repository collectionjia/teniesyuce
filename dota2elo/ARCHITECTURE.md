# Dota2 Elo — 技术架构

> 给开发者看的实现细节：模块划分、数据流、Elo 算法、扩展点。

---

## 1. 系统总览

```
┌────────────────────────────────────────────────────────────────────┐
│                          外部数据源                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   OpenDota   │  │    Stratz    │  │ dota-pro-db (T1 SQLite)  │  │
│  │ (REST/公共)  │  │ (GraphQL)    │  │ Betty HF (parquet)       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │
└─────────┼──────────────────┼──────────────────────┼────────────────┘
          │                  │                      │
          ▼                  ▼                      ▼
   ┌──────────────────────────────────────────────────────────┐
   │                 sources/ (数据源抽象层)                   │
   │  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌────────────┐  │
   │  │  cache  │  │  multi  │  │   cross  │  │ MatchSource│  │
   │  │ (TTL)   │→ │ (回退)  │→ │ (校验)   │  │  Protocol  │  │
   │  └─────────┘  └─────────┘  └──────────┘  └────────────┘  │
   └────────────────────────┬─────────────────────────────────┘
                            │ 统一 schema (Match / Team)
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │                    ingest / Elo 引擎                      │
   │  ┌────────────────┐  ┌──────────────────────────────────┐│
   │  │ ingest.py      │  │ elo.py                           ││
   │  │ - 拉取         │  │ - expected_win                   ││
   │  │ - 持久化       │  │ - update_ratings                 ││
   │  │ - 重算         │  │ - composite_rating (4 维)        ││
   │  └────────────────┘  │ - draft_advantage                ││
   │                      │ - is_high_confidence (5 条件)    ││
   │                      │ - upset_risk (4 因子)            ││
   │                      │ - upset_adjusted_prob            ││
   │                      │ - k_factor (按 series_type)     ││
   │                      └──────────────────────────────────┘│
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │                    持久化层 (SQLite)                      │
   │  Team / Match / RatingHistory / SourceCache / IngestJob  │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │                 API 层 (FastAPI)                          │
   │  16 个端点，分 3 组：                                      │
   │  - 页面 (HTML)  /rankings /predict /team /admin          │
   │  - 查询 (JSON)  /api/rankings /predict /teams /matches   │
   │  - 管理 (JSON)  /api/admin/ingest /jobs /cache /recompute│
   └──────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         浏览器用户    REST 集成方    CLI 用户
```

---

## 2. 模块详解

### 2.1 `dota2elo/elo.py` — 评分引擎（核心）

所有算法逻辑都在这里，**纯函数 + 轻 dataclass**，无副作用，易测试。

#### 2.1.1 基础 Elo

```python
def expected_win(rating_a: float, rating_b: float) -> float:
    """Elo 标准 logistic 期望胜率"""
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))

def update_ratings(rating_a, rating_b, score_a, k):
    """根据实际结果 (0/0.5/1) 更新双方评分"""
    e_a = expected_win(rating_a, rating_b)
    e_b = 1 - e_a
    new_a = rating_a + k * (score_a - e_a)
    new_b = rating_b + k * ((1 - score_a) - e_b)
    return new_a, new_b
```

#### 2.1.2 K 因子（按赛事分级）

```python
K_BY_SERIES_TYPE = {"BO1": 10, "BO3": 25, "BO5": 50}
K_FACTOR_BY_LEAGUE = {
    "The International": 60,
    "Major": 50,
    "DPC Division I": 40, "DPC Division II": 40,
    "Tier 1": 32, "Tier 2": 24, "Tier 3": 24,
    "DEFAULT": 20,
}

def k_factor(match) -> float:
    """优先按 series_type，否则按 league name"""
    if match.series_type in K_BY_SERIES_TYPE:
        return K_BY_SERIES_TYPE[match.series_type]
    for kw, k in K_FACTOR_BY_LEAGUE.items():
        if kw.lower() in match.league_name.lower():
            return k
    return K_FACTOR_BY_LEAGUE["DEFAULT"]
```

#### 2.1.3 4 维复合评分

```python
WEIGHTS = {
    "team":   0.55,  # 团队整体 Elo
    "player": 0.20,  # 5 名选手加权
    "hero":   0.15,  # 当前补丁英雄池胜率
    "patch":  0.10,  # 距上次补丁 ≤ 14 天的表现
}

def composite_rating(team, player, hero, patch):
    return (team * 0.55 + player * 0.20
          + hero * 0.15 + patch * 0.10)
```

注：v1.0 选手/英雄/补丁维度数据**未自动填充**，结构已就位，需 OpenDota match detail
抓取 `picks_bans` + `players` 后启用。

#### 2.1.4 高置信度过滤（5 条件）

```python
def is_high_confidence(team_a, team_b, ...):
    return all([
        both_teams_have_min_30_matches(team_a, team_b),
        both_teams_have_played_in_current_patch(team_a, team_b),
        elo_diff_within_reasonable_range(team_a, team_b),  # |ΔElo| < 200
        is_BO3_or_BO5(...),  # 排除 BO1
        no_recent_roster_change(...),  # 30 天内无换人
    ])
```

#### 2.1.5 冷门风险引擎

```python
def upset_risk(match, team_a, team_b):
    risk = 0
    if match.series_type == "BO1":        risk += 25
    if patch_age_days <= 7:                risk += 20
    if roster_change_30d(team_a) or _b():  risk += 15
    if hidden_hero_pool(team_a) or _b():   risk += 20
    return min(risk, 100)

def upset_adjusted_prob(base_p, risk):
    """高风险 → 拉向 50%"""
    return base_p * (1 - risk/100) + 0.5 * (risk/100)
```

#### 2.1.6 草稿优势（可选）

```python
def draft_advantage(picks_bans_a, picks_bans_b, hero_pool):
    """基于 picks_bans + 双方英雄池计算 -1 ~ +1 优势分"""
    ...
```

### 2.2 `dota2elo/sources/` — 数据源抽象

#### 2.2.1 `MatchSource` Protocol

```python
class MatchSource(Protocol):
    async def get_pro_matches(self, less_than_match_id: int | None = None) -> list[Match]: ...
    async def get_match(self, match_id: int) -> Match | None: ...
    async def get_team(self, team_id: int) -> Team | None: ...
```

#### 2.2.2 三层装饰器

```
RawClient (opendota.py / stratz.py / dota-pro-db / betty_hf)
    ↓ wrap
CachedSource (TTL: match=1h, team=24h, SourceCache 表)
    ↓ wrap
MultiSourceClient (主源失败 → 兜底源)
    ↓
上层 (ingest.py)
```

#### 2.2.3 缓存层 (`sources/cache.py`)

- 用 `SourceCache` 表（key, value_json, fetched_at, expires_at）
- match 1h、team 24h TTL
- `DOTA2ELO_CACHE=0` 全局关闭
- `/api/admin/cache/stats` 看命中
- `/api/admin/cache/clear` 一键清

### 2.3 `dota2elo/opendota.py` — OpenDota 客户端

- 异步 httpx + 1.1 req/s 令牌桶节流
- 字段映射到统一 `Match` / `Team` schema
- 失败重试 3 次（指数退避）
- 429 触发自动暂停 60s

### 2.4 `dota2elo/stratz.py` — Stratz 客户端

- GraphQL 查询，POST `https://api.stratz.com/graphql`
- 0.4 req/s 节流（Stratz 比 OpenDota 限速更严）
- Bearer token 认证
- 字段映射同上

### 2.5 `dota2elo/importers/` — 离线导入

- `dota_pro_db.py` — 从 https://github.com/dca123/dota-pro-db/releases 下载 T1 SQLite
  - 解析 `matches` / `teams` / `picks_bans` / `players` 表
  - 直接 upsert 到主 DB
- `betty_hf.py` — Betty HuggingFace parquet 导入
  - 依赖 `pyarrow`
  - 下载受 CDN 限制（国内 403）

### 2.6 `dota2elo/api.py` — FastAPI 17 端点（v1.4）

| 端点 | 方法 | 标签 | 说明 |
|---|---|---|---|
| `/` | GET | 页面 | 排行榜首页 |
| `/predict` | GET | 页面 | 对阵预测 UI |
| `/team/{id}` | GET | 页面 | 战队详情 + 趋势图 |
| `/admin` | GET | 页面 | 管理面板 |
| `/api/health` | GET | 查询 | 健康检查 |
| `/api/rankings` | GET | 查询 | 排行榜 JSON |
| `/api/teams` | GET | 查询 | 模糊搜战队 |
| `/api/teams/{id}` | GET | 查询 | 战队详情 |
| `/api/players` ⭐ | GET | 查询 | 选手榜（v1.3） |
| `/api/players/{id}` ⭐ | GET | 查询 | 选手详情（v1.3） |
| `/api/predict` | GET | 查询 | 预测胜率（核心，75%+80% 条件） |
| `/api/matches` | GET | 查询 | 最近比赛 |
| `/api/calibration` | GET | 查询 | Elo 差→胜率校准表 |
| `/api/backtest` | GET | 查询 | 回测指标 |
| `/api/admin/ingest` | POST | 管理 | 启动后台 ingest |
| `/api/admin/jobs` | GET | 管理 | 任务列表 |
| `/api/admin/jobs/{id}` | GET | 管理 | 任务详情 |
| `/api/admin/cache/stats` | GET | 管理 | 缓存统计 |
| `/api/admin/cache/clear` | POST | 管理 | 清空缓存 |
| `/api/admin/recompute` | POST | 管理 | 同步全量重算 |
| `/api/admin/recalibrate` | POST | 管理 | 重建校准表 |
| `/docs` | GET | - | Swagger UI |
| `/openapi.json` | GET | - | OpenAPI 3.1 规范 |

### 2.7 `dota2elo/jobs.py` — 后台任务

- `IngestJob` ORM 表持久化任务状态
- 线程池执行，状态轮询
- `job.status ∈ {pending, running, success, failed}`
- `job.error_message` 记录异常堆栈

### 2.8 `dota2elo/scheduler.py` — 系统调度

- **macOS**：launchd plist 写入 `~/Library/LaunchAgents/`
  - `StartInterval` 控制频率
  - `RunAtLoad=true` 立刻跑
  - 包装脚本 `~/.local/bin/dota2elo-ingest.sh` 绕过沙箱
- **Linux**：提示用户配置 cron（不直接写入）
- `schedule doctor` 自动诊断权限/路径问题

### 2.9 `dota2elo/models.py` — ORM

5 张表：

| 表 | 字段（核心） |
|---|---|
| `teams` | id, name, tag, logo_url, current_elo, matches_played, last_match_at |
| `matches` | id, league_id, league_name, series_type, start_time, duration, radiant_team_id, dire_team_id, radiant_win, patch, source, source_meta_json |
| `rating_history` | id, team_id, match_id, rating_before, rating_after, rating_change, k_factor, composite_score, is_upset |
| `source_cache` | cache_key, source, value_json, fetched_at, expires_at |
| `ingest_jobs` | job_id, status, source, started_at, finished_at, progress_json, error_message |

索引：matches(start_time), rating_history(team_id, match_id), teams(name), source_cache(cache_key, source)

### 2.10 `run.py` — CLI 入口

```bash
python run.py <subcommand> [args]

subcommands:
  ingest [--source=auto|opendota|stratz|multi] [--limit=N]
  serve [--host=0.0.0.0] [--port=3001]
  predict <teamA> <teamB> [--bo=BO3]
  show <team> [--limit=10]
  cross-check [--pages=1]
  cache [stats|clear]
  schedule [install|uninstall|status|logs|doctor] [--every=6h]
  import-pro-db [--db-path=PATH]
  import-betty [--parquet-path=PATH]
```

---

## 3. 数据流（关键路径）

### 3.1 拉取 + 重算（`python run.py ingest`）

```
ingest.full_ingest(source, limit)
   ↓
MultiSourceClient.get_pro_matches(less_than_match_id)
   ↓ (循环) CachedSource 查/写 → 主源失败回退
   ↓
每个 match_id 走 upsert_pro_match → DB
   ↓
recompute_all_ratings()  # 按时间正序遍历
   ↓ 每个 match:
   load 双方 Team → 读 current_elo
   ↓ k_factor(match)
   update_ratings → 写 RatingHistory → 更新 Team.current_elo
   ↓
commit
```

### 3.2 预测（`GET /api/predict`）

```
request: a=Team Spirit, b=Team Liquid, bo=BO3
   ↓
load Team A / Team B from DB
   ↓
elo_a, elo_b = team.current_elo
   ↓
base_p = expected_win(elo_a, elo_b)
   ↓
composite_p = composite_rating(team, player, hero, patch)
   ↓
upset_risk → upset_adjusted_prob(composite_p, risk)
   ↓
is_high_confidence(a, b, ...) → bool
   ↓
return {
  base_p, composite_p, upset_adjusted_prob,
  is_high_confidence, risk_points, k_factor, ...
}
```

### 3.3 后台 ingest（`POST /api/admin/ingest`）

```
request: source=auto, max_pages=20
   ↓
jobs.create_job(source, max_pages) → job_id, status=pending
   ↓
threading.Thread(target=full_ingest, args=(...)).start()
   ↓
return { job_id }  # 不阻塞浏览器
   ↓
前端每 5s 轮询 GET /api/admin/jobs/{job_id}
   ↓
jobs.update_progress(job_id, progress_json)
   ↓
完成 → status=success / failed
```

---

## 4. 评分算法数学细节

### 4.1 期望胜率

$$E_A = \frac{1}{1 + 10^{(R_B - R_A) / 400}}$$

### 4.2 评分更新

$$R'_A = R_A + K \cdot (S_A - E_A)$$

### 4.3 复合评分

$$R^{comp} = 0.55 \cdot R^{team} + 0.20 \cdot R^{player} + 0.15 \cdot R^{hero} + 0.10 \cdot R^{patch}$$

### 4.4 冷门风险调整

$$R^{upset} = R^{comp} \cdot (1 - r/100) + 0.5 \cdot (r/100), \quad r \in [0, 100]$$

### 4.5 K 因子分级

| 赛事级别 | K | 例子 |
|---|---|---|
| The International | 60 | TI 2025 / TI 2026 |
| Major | 50 | ESL One, DreamLeague |
| DPC Div I/II | 40 | DPC 联赛 |
| Tier 1 其他 | 32 | EPL Masters |
| Tier 2/3 | 24 | 区域赛 |
| 默认 | 20 | 未知 |
| BO1 (按 series_type) | 10 | 单场 |
| BO3 | 25 | 三场两胜 |
| BO5 | 50 | 五场三胜 |

`series_type` 优先于 league name（TI 的 BO1 也按 10 算）。

### 4.6 回测指标

**Log Loss**：

$$L = -\frac{1}{N}\sum_{i=1}^{N} [y_i \log p_i + (1-y_i)\log(1-p_i)]$$

**Brier Score**：

$$B = \frac{1}{N}\sum_{i=1}^{N}(p_i - y_i)^2$$

---

## 5. 扩展点

### 5.1 新增数据源

```python
# 1) 写一个 client，实现 MatchSource Protocol
class MyNewSource:
    async def get_pro_matches(self, less_than_match_id=None): ...
    async def get_match(self, match_id): ...
    async def get_team(self, team_id): ...

# 2) 注册到 sources/__init__.py
SOURCES["mynew"] = MyNewSource

# 3) 配置 DOTA2ELO_SOURCE=mynew
```

### 5.2 新增评分维度

```python
# elo.py
WEIGHTS = {"team": 0.50, "player": 0.20, "hero": 0.15, "patch": 0.05, "coach": 0.10}

def composite_rating(team, player, hero, patch, coach):
    return (team * 0.50 + player * 0.20 + hero * 0.15
          + patch * 0.05 + coach * 0.10)
```

### 5.3 新增冷门风险因子

```python
def upset_risk(match, team_a, team_b):
    risk = 0
    # ... 现有因子 ...
    if is_international_debut(team_a):  # 新增
        risk += 10
    return min(risk, 100)
```

### 5.4 新增 API 端点

```python
# api.py
@app.get("/api/my-endpoint", tags=["查询"])
async def my_endpoint():
    ...
```

OpenAPI 规范自动生成（`openapi.json`）。

### 5.5 新增 Web 页面

```python
# api.py
@app.get("/my-page", response_class=HTMLResponse)
async def my_page(request: Request):
    return templates.TemplateResponse("my_page.html", {"request": request})
```

模板放 `web/templates/`，静态资源放 `web/static/`。

---

## 6. 性能 & 限制

| 项 | 限制 | 影响 |
|---|---|---|
| OpenDota 限速 | ~1 req/s | 拉 100 场约 100s |
| Stratz 限速 | ~0.4 req/s | 更慢 |
| SQLite 并发写 | 串行 | 适合单机，不适合集群 |
| 单进程 ingest | 1 任务同时 | 后台任务排队 |
| 内存 | < 200 MB | 130 队 2000 场实测 ~50 MB |

**生产化建议**：
- 替换 SQLite → PostgreSQL（改 `db.py` 的 `DATABASE_URL`）
- 加重试队列（Celery / RQ）
- 前端加 CDN
- ingest 限速根据上游配额调整

---

## 7. 测试

v1.0 未集成 `pytest`，所有验证通过 `curl` 手工跑：
- `/api/health` 200
- `/api/rankings` 200 + JSON
- `/api/predict` 200 + 概率在 [0, 1]
- `/api/backtest` log_loss < 0.7

下一步：把 `elo.py` 的纯函数抽到 `test_elo.py`，加覆盖率。

---

## 8. 调试技巧

```bash
# 看 ingest 错误
tail -f data/ingest.err

# 强制重算（不删库）
python run.py ingest --limit 50

# 重置某场比赛之后的评分
python3 -c "
from dota2elo.db import SessionLocal
from dota2elo.models import RatingHistory
from datetime import datetime
s = SessionLocal()
s.query(RatingHistory).filter(RatingHistory.match_id > 8000000).delete()
s.commit()
"

# 看缓存
python run.py cache stats

# 看某个 API 原始 SQL
# 在 api.py 的端点里加 session.bind.echo = True
```

---

## 9. 依赖树

```
fastapi
├── pydantic
├── pydantic-settings
├── starlette (FastAPI 内部)
└── uvicorn[standard]
    ├── uvloop (高性能事件循环)
    ├── httptools
    ├── websockets
    └── watchfiles

sqlalchemy
├── greenlet
└── typing-extensions

httpx
├── anyio
├── httpcore
├── h11
├── idna
└── certifi

jinja2
python-multipart
python-dateutil
```

无 C 扩展编译依赖，**纯 pip install** 可装。

---

## 10. 维护清单

| 项 | 频率 | 工具 |
|---|---|---|
| 升级依赖 | 月度 | `pip list --outdated` |
| 拉新数据 | 6h | launchd / cron |
| 备份 SQLite | 周 | `cp data/dota2elo.db backup/` |
| 调权重 | 季度 | `/api/backtest` 观察 log_loss |
| 检查 Stratz 配额 | 月 | Stratz dashboard |
| OpenAPI 同步 | 改 api.py 时 | 访问 `/openapi.json` |
