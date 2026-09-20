"""联赛层级映射（v1.5 新增）。

解决 Elo 模型在跨层级比赛上的系统性偏差：
- T1 队 vs T3 队的 Elo 差远小于真实实力差
- 市场（Polymarket）能区分 Tier，但 Elo 不能
- 给预测加 tier_gap_warning，让用户知道模型置信度边界

数据来源：Liquipedia Dota2 联赛分级 + OpenDota 联赛元数据。
"""
from __future__ import annotations
from typing import Optional


# 联赛层级（数字越小越顶级）
# Tier 1: Major / TI / EWC / BLAST Slam / ESL One / DreamLeague
# Tier 2: 区域 Premier / DPC Div I / 中型邀请赛
# Tier 3: 小型 online / 资格赛 / 区域联赛
# Tier 4: 草根 / 业余
TIERS_BY_LEAGUE_ID: dict[int, int] = {
    # Tier 1 — 全球顶级
    18324: 1,   # The International 2025
    19719: 1,   # The International 2026
    18375: 1,   # Esports World Cup 2025
    19785: 1,   # Esports World Cup 2026
    17891: 1,   # PGL Wallachia 2025 Season 3
    18058: 1,   # PGL Wallachia 2025 Season 4
    18358: 1,   # PGL Wallachia 2025 Season 5
    18359: 1,   # Clavision DOTA2 Masters 2025
    18111: 1,   # DreamLeague Season 26
    17765: 1,   # DreamLeague Season 25
    17907: 1,   # FISSURE Universe Episode 4
    18433: 1,   # FISSURE Universe Episode 6
    17795: 1,   # ESL One Raleigh 2025
    17588: 1,   # FISSURE PLAYGROUND 1
    20009: 1,   # 1win Essence II (实际是 T1 satellite)

    # Tier 2 — 区域 Premier / 中等邀请赛
    19944: 2,   # EPL Masters 2026
    18111: 2,   # (重复 key 风险：上面是 DreamLeague S26)
    20030: 2,   # The Boris Invitational
    17417: 2,   # SLAM II
    17418: 2,   # SLAM III
    19917: 2,   # The Games of the Future 2026

    # Tier 3 — 小型 online / 资格赛
    19917: 3,   # (实际是 T3 satellite)
}

# 名称 fallback（处理 league_id = 0 或新联赛）
TIERS_BY_NAME_PATTERNS: list[tuple[str, int]] = [
    # Tier 1 keywords
    ("The International", 1),
    ("Esports World Cup", 1),
    ("PGL Wallachia", 1),
    ("DreamLeague", 1),
    ("ESL One", 1),
    ("BLAST Slam", 1),
    ("FISSURE Universe", 1),
    ("FISSURE PLAYGROUND", 1),
    ("Clavision", 1),
    ("1win Essence", 1),
    ("BetBoom Dacha", 1),
    ("Riyadh Masters", 1),

    # Tier 2 keywords
    ("EPL Masters", 2),
    ("European Pro League", 2),
    ("Ultras DPL", 2),
    ("Ultras Dota Pro League", 2),
    ("DreamLeague Division", 2),
    ("SLAM", 2),
    ("BLAST Slam", 2),
    ("Resurrect", 2),
    ("Games of the Future", 2),
    ("Boris Invitational", 2),
    ("Premier Series", 2),

    # Tier 3 keywords
    ("Destiny League", 3),
    ("Dota 2 Space League", 3),
    ("EPL World Series", 3),
    ("Road To EWC", 3),
    ("Road to ENC", 3),
    ("SIVVIT", 3),
    ("WB team", 3),
    ("WB Team", 3),
    ("RES Unchained", 3),
    ("1win", 3),

    # Tier 4
    ("ExitLag ChampZ", 4),
    ("ChampZ", 4),
    ("CyberClub", 4),
    ("Streamer Battles", 4),
    ("扭蛋杯", 4),
    ("LIHUI", 4),
]


# 简写
TIER_NAMES = {1: "T1", 2: "T2", 3: "T3", 4: "T4"}

# 默认未知联赛按 T3 处理（保守）
DEFAULT_TIER = 3


def get_tier(league_id: Optional[int] = None, league_name: Optional[str] = None) -> int:
    """获取联赛层级。优先用 league_id，回退到名称匹配，最后用默认值。"""
    if league_id and league_id in TIERS_BY_LEAGUE_ID:
        return TIERS_BY_LEAGUE_ID[league_id]
    if league_name:
        for pattern, tier in TIERS_BY_NAME_PATTERNS:
            if pattern in league_name:
                return tier
    return DEFAULT_TIER


def tier_gap(tier_a: int, tier_b: int) -> int:
    """两个 tier 的差距（绝对值）。"""
    return abs(tier_a - tier_b)


def tier_warning(tier_a: int, tier_b: int) -> Optional[str]:
    """当跨层级明显时返回警告文本，否则 None。

    规则：
    - gap >= 2：模型系统性偏差，建议参考市场
    - gap == 1：轻微提醒
    - gap == 0：无
    """
    gap = tier_gap(tier_a, tier_b)
    if gap == 0:
        return None
    higher = tier_a if tier_a < tier_b else tier_b  # 数字小 = 更顶级
    lower = tier_b if tier_a < tier_b else tier_a
    if gap >= 2:
        return (
            f"跨 {gap} 层级比赛（{TIER_NAMES[higher]} vs {TIER_NAMES[lower]}）。"
            "Elo 不区分联赛质量，模型可能低估高级别队胜率，"
            "建议结合 Polymarket 等市场赔率参考。"
        )
    return (
        f"差 1 层级比赛（{TIER_NAMES[higher]} vs {TIER_NAMES[lower]}）。"
        "模型置信度略降。"
    )


if __name__ == "__main__":
    # 自检
    test_cases = [
        (18324, "The International 2025", 1),
        (19944, "EPL Masters 2026", 2),
        (None, "Destiny League", 3),
        (None, "Some Random Online Cup", 3),  # default
        (19785, "Esports World Cup 2026", 1),
        (None, "RES Unchained - A Blast Dota S", 3),
        (None, "1win Essence II", 1),
    ]
    print("league_id  league_name                              → tier")
    for lid, name, expected in test_cases:
        got = get_tier(lid, name)
        status = "✓" if got == expected else "✗"
        print(f"  {str(lid):>6}  {name:<42} → {TIER_NAMES.get(got, got)} {status}")

    # Tier gap 演示
    print()
    print("=== 跨层警告测试 ===")
    for a_name, b_name in [
        ("PGL Wallachia", "RES Unchained"),
        ("ESL One", "EPL Masters"),
        ("DreamLeague", "Destiny League"),
    ]:
        ta = get_tier(None, a_name)
        tb = get_tier(None, b_name)
        w = tier_warning(ta, tb)
        print(f"  {a_name} ({TIER_NAMES[ta]}) vs {b_name} ({TIER_NAMES[tb]}):")
        print(f"    {w or '无警告'}")