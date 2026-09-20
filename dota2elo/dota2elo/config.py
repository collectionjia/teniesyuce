"""配置：Elo 参数、API 限速、数据库路径、K 因子分级。"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Optional

# ----- 路径 -----
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "dota2elo.db"

# ----- OpenDota API -----
OPENDOTA_BASE = "https://api.opendota.com/api"
# OpenDota 公共 API 礼貌速率：~1 req/s
OPENDOTA_RATE_LIMIT_SECONDS = 1.1
# 拉取 proMatches 单次最多 100 条，需要翻页
PRO_MATCHES_PAGE_SIZE = 100

# ----- Stratz GraphQL API -----
# 免费 tier 需要注册 https://stratz.com/api 拿 key
STRATZ_URL = "https://api.stratz.com/graphql"
STRATZ_RATE_LIMIT_SECONDS = 0.4  # 免费层约 2-3 req/s，保守取 0.4s 间隔
STRATZ_API_KEY: Optional[str] = os.getenv("STRATZ_API_KEY") or None

# 多源选择：auto 模式下，配置了 STRATZ_API_KEY 就用 stratz 优先 + opendota 兜底
DEFAULT_SOURCE = os.getenv("DOTA2ELO_SOURCE", "auto")  # auto | opendota | stratz | multi

# ----- Elo 默认参数 -----
INITIAL_ELO = 1500.0
ELO_FLOOR = 800.0
ELO_CEILING = 2800.0
PROVISIONAL_MATCHES = 10  # 头 N 场用更高的 K 因子（2x），更快收敛

# ----- K 因子分级（融合版本：series_type 优先，league 兜底） -----
# series_type 映射（来自 Stratz/OpenDota 标准）：
#   0 = BO1
#   1 = BO3
#   2 = BO5
#   3 = BO3 (alt encoding)
K_BY_SERIES_TYPE: Dict[int, float] = {
    0: 10.0,    # BO1 — 翻车率高，K 最小
    1: 25.0,    # BO3 regular
    2: 50.0,    # BO5 (TI 决赛) — 信号最强
    3: 25.0,    # BO3 alt
}

# 关键词匹配联赛名（不区分大小写），当 series_type 不可用时用
K_FACTOR_BY_LEAGUE: Dict[str, float] = {
    "the international": 60.0,
    "ti": 60.0,
    "major": 50.0,
    "dreamleague": 50.0,
    "esl one": 50.0,
    "epicenter": 50.0,
    "mdl": 50.0,
    "dpc": 40.0,                # DPC Division I / II
    "division i": 40.0,
    "division ii": 40.0,
    "esl": 32.0,                # 其他 ESL 系列
    "iem": 32.0,
    "dota pro circuit": 40.0,
}
DEFAULT_K = 20.0
TIER_FALLBACK_K = {
    "professional": 32.0,
    "tier 1": 32.0,
    "tier1": 32.0,
    "tier 2": 24.0,
    "tier2": 24.0,
    "tier 3": 24.0,
    "tier3": 24.0,
    "minor": 24.0,
    "qualifier": 24.0,
    "online": 20.0,
}


def k_factor_for_league(league_name: str | None) -> float:
    """根据联赛名取 K 因子。"""
    if not league_name:
        return DEFAULT_K
    name = league_name.lower()
    # 精确关键词优先级排序
    for key, k in K_FACTOR_BY_LEAGUE.items():
        if key in name:
            return k
    for key, k in TIER_FALLBACK_K.items():
        if key in name:
            return k
    return DEFAULT_K
