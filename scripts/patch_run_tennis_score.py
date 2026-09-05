"""Add scoreText to slim_event in sofascore/run_tennis.py."""
from __future__ import annotations

from pathlib import Path

P = Path("/opt/yuce/bbbbb/sofascore/run_tennis.py")

HELPER = '''

def event_score_text(ev: dict) -> str:
    hs = ev.get("homeScore") or {}
    aws = ev.get("awayScore") or {}
    parts: list[str] = []
    for key in ("period1", "period2", "period3", "period4", "period5"):
        if key in hs and key in aws:
            parts.append(f"{hs[key]}-{aws[key]}")
    if parts:
        return " ".join(parts)
    hc = hs.get("current")
    ac = aws.get("current")
    if hc is not None and ac is not None:
        return f"{hc}-{ac}"
    return ""
'''

OLD = '''    return {
        "id": ev.get("id"),
        "level": tour_level_label(points, tour.lower()),
        "tour": tour,
        "tennisPoints": points,
        "tournament": tournament.get("name") or unique.get("name"),
        "tournamentShort": unique.get("name") or tournament.get("name"),
        "status": (ev.get("status") or {}).get("description"),
        "statusType": (ev.get("status") or {}).get("type"),
        "home": home.get("name"),
        "away": away.get("name"),
        "homePlayer": home,
        "awayPlayer": away,
        "home_score": (ev.get("homeScore") or {}).get("current"),
        "away_score": (ev.get("awayScore") or {}).get("current"),
        "startTimestamp": ev.get("startTimestamp"),
        "roundInfo": ev.get("roundInfo"),
        "roundLabel": round_label(ev.get("roundInfo")),
        "groundType": ev.get("groundType") or unique.get("groundType"),
        "groundLabel": ground_label(ev.get("groundType") or unique.get("groundType")),
        "gender": gender,
        "slug": ev.get("slug"),
        "customId": ev.get("customId"),
    }'''

NEW = '''    out = {
        "id": ev.get("id"),
        "level": tour_level_label(points, tour.lower()),
        "tour": tour,
        "tennisPoints": points,
        "tournament": tournament.get("name") or unique.get("name"),
        "tournamentShort": unique.get("name") or tournament.get("name"),
        "status": (ev.get("status") or {}).get("description"),
        "statusType": (ev.get("status") or {}).get("type"),
        "home": home.get("name"),
        "away": away.get("name"),
        "homePlayer": home,
        "awayPlayer": away,
        "home_score": (ev.get("homeScore") or {}).get("current"),
        "away_score": (ev.get("awayScore") or {}).get("current"),
        "startTimestamp": ev.get("startTimestamp"),
        "roundInfo": ev.get("roundInfo"),
        "roundLabel": round_label(ev.get("roundInfo")),
        "groundType": ev.get("groundType") or unique.get("groundType"),
        "groundLabel": ground_label(ev.get("groundType") or unique.get("groundType")),
        "gender": gender,
        "slug": ev.get("slug"),
        "customId": ev.get("customId"),
    }
    score_text = event_score_text(ev)
    if score_text:
        out["scoreText"] = score_text
    return out'''


def apply() -> None:
    text = P.read_text(encoding="utf-8")
    if "def event_score_text" not in text:
        anchor = "def slim_event(ev: dict) -> dict:"
        text = text.replace(anchor, HELPER + "\n" + anchor, 1)
    if 'out["scoreText"]' not in text:
        if OLD not in text:
            raise SystemExit("slim_event block not found")
        text = text.replace(OLD, NEW, 1)
    P.write_text(text, encoding="utf-8")
    print("run_tennis.py patched")


if __name__ == "__main__":
    apply()
