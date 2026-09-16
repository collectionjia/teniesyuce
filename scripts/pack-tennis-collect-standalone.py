#!/usr/bin/env python3
"""把网球采集打成可单独交付的目录（不含密钥）。

用法（在仓库根目录）:
  python scripts/pack-tennis-collect-standalone.py

输出:
  dist/tennis-collect-standalone/
"""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts" / "tennis-monitor"
OUT = ROOT / "dist" / "tennis-collect-standalone"

# 采集运行必需 + 说明；默认带上本地 monitor.env（含密钥，仅内部分发）
COPY_FILES = [
    "collect.py",
    "collect_live.py",
    "requirements.txt",
    "env.monitor.example",
    "env.monitor.test.example",
    "env.monitor.prod.example",
    "config/schedule.json",
    "monitor.env",
]

COPY_TREES = [
    "tm",
]


README = r'''# 网球采集（独立交付包）

本目录可单独拷贝给他人使用，**不依赖**主站前端 / Node server 业务代码。  
入口是 `collect.py`：拉 Sofascore 赛程 + Top100 过滤 + Polymarket 赔率，写入 Redis / 本地 JSON。

## 整体流程

```
collect.py
  └─ tm/collectors/tier_collect.py      # 主编排
       ├─ IPWO 代理预热                 # tm/clients/proxy.py
       ├─ Top100 + 赛事                 # tm/collectors/top100.py / events.py / rankings.py
       ├─ Polymarket 外链/赔率          # tm/clients/polymarket.py
       ├─ 排名与赔率补全                # tm/bundle.py
       ├─ 结果输出                      # output/daily_bundle_*.json
       └─ 写入 Redis                    # tm/bundle_store.py → tennis:bundle:full
```

时间范围（今天起 1/2/5 天）读自 `config/schedule.json` 的 `collect_horizon_days`。

## 目录说明

| 路径 | 作用 |
|------|------|
| `collect.py` | **主入口**：未开赛 / Top100 全量采集 |
| `collect_live.py` | 盘中采集（可选） |
| `tm/` | 采集实现库 |
| `tm/collectors/events.py` | 按日期拉赛事列表（含 horizon） |
| `tm/collectors/top100.py` | ATP/WTA Top100 过滤 |
| `tm/collectors/tier_collect.py` | 六步编排 |
| `tm/clients/sofascore.py` | Sofascore HTTP |
| `tm/clients/polymarket.py` | Polymarket |
| `tm/clients/proxy.py` | IPWO 代理 |
| `tm/bundle_store.py` | 写 Redis / 文件 |
| `config/schedule.json` | 采集间隔、`collect_horizon_days` 等 |
| `env.monitor.example` | 环境变量模板 |

## 环境准备

```bash
cd tennis-collect-standalone
python -m venv .venv

# Windows
.venv\Scripts\activate
# Linux / macOS
# source .venv/bin/activate

pip install -r requirements.txt
# 本包已含 monitor.env（代理 / Redis 等）；也可自行对照 env.monitor.example 修改
```

`monitor.env` 关键项：

- `IPWO_PROXY_*` 或 `SOFA_HTTP_PROXY`：住宅代理（机房 IP 常被 Sofascore 403）
- `REDIS_URL`：要写入 Redis 时必填；不配则只落本地文件
- `SOFA_WRITE_MYSQL=0`：默认不写 MySQL

**注意：包内 `monitor.env` 含密钥，仅限内部分发，勿公开上传。**

## 怎么跑

在本目录下执行（工作目录必须是包根目录，才能 `import tm`）：

```bash
python collect.py                 # 今天，Top100 过滤（默认）
python collect.py 2026-09-15      # 指定起始日
python collect.py --all           # 不过滤 Top100（tier 全量）
```

成功示例输出：

```
完成: N 场 · PM … · Redis ✓ N 场 · HTTP … · 总耗时 …
```

## 改采集天数

编辑 `config/schedule.json`：

```json
{
  "collect_horizon_days": 2
}
```

允许值：`1` / `2` / `3` / `5`（从今天起连续天数）。

也可由主站「Top100采集」弹窗写入同一字段（若对接主仓库的 schedule API）。

## 产出

- Redis key：`tennis:bundle:full`（全量赛程包）
- 文件：`output/daily_bundle_*.json`（若目录可写）
- 标识：`dataSource=collect`，与盘中 `collect_live` 分开

## 常见问题

1. **Sofascore 403 challenge**  
   机房 IP 被拦 → 在 `monitor.env` 配可用 IPWO 住宅代理。

2. **CONNECT tunnel failed / curl 7**  
   代理账号、额度或 host/port 错误。

3. **Redis 跳过 / 失败**  
   检查 `REDIS_URL`；失败时仍可能有本地 JSON。

4. **0 场**  
   当天无 Top100 相关赛事，或 horizon/日期不对；退出码仍为 0。

## 与主站关系（可选）

主仓库里由 Node `server/src/services/tennisCollectRunner.js` 调本目录的 `collect.py`；  
管理页 / Top100「采集」按钮走 `POST /admin/tennis-monitor/collect`。  
**本包可完全脱离主站单独跑。**

## 版本

从主仓库 `scripts/tennis-monitor` 打包生成；含 `monitor.env` 时仅限内部分发。
'''


def main() -> int:
    if not SRC.is_dir():
        print(f"missing source: {SRC}")
        return 1
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for rel in COPY_FILES:
        src = SRC / rel
        if not src.exists():
            print(f"skip missing: {rel}")
            continue
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"copy {rel}")

    for rel in COPY_TREES:
        src = SRC / rel
        dst = OUT / rel
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(
            src,
            dst,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache"),
        )
        print(f"copy tree {rel}/")

    (OUT / "README.md").write_text(README, encoding="utf-8")
    print(f"wrote {OUT / 'README.md'}")
    print(f"\nOK → {OUT}")
    if (OUT / "monitor.env").exists():
        print("已包含 monitor.env（含密钥）— 仅限内部分发，勿公开。")
    else:
        print("未找到 monitor.env，对方需自行配置。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
