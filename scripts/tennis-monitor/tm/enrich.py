from __future__ import annotations

from typing import Any


def _birth_year_from_team(team: dict) -> int | None:
    """从 Sofascore team/player 对象解析出生年（含 dateOfBirthTimestamp / 年月日字符串）。"""
    if not isinstance(team, dict):
        return None
    info = team.get("playerTeamInfo") if isinstance(team.get("playerTeamInfo"), dict) else {}
    for src in (team, info):
        for key in ("birthYear", "yearOfBirth"):
            raw = src.get(key)
            if raw is None or raw == "":
                continue
            try:
                y = int(raw)
                if 1940 <= y <= 2018:
                    return y
            except (TypeError, ValueError):
                pass
        ts = src.get("dateOfBirthTimestamp") or src.get("birthDateTimestamp")
        if ts:
            try:
                from datetime import datetime, timezone

                y = datetime.fromtimestamp(int(ts), timezone.utc).year
                if 1940 <= y <= 2018:
                    return y
            except (TypeError, ValueError, OSError, OverflowError):
                pass
        raw = src.get("dateOfBirth") or src.get("birthDate") or src.get("dateOfBirthDate")
        if raw:
            s = str(raw).strip()
            for part in (s[:4], s[-4:]):
                try:
                    yi = int(part)
                    if 1940 <= yi <= 2018:
                        return yi
                except ValueError:
                    pass
    return None


def _player_side(ev: dict, side: str) -> dict:
    team = ev.get(f"{side}Team") or ev.get(side) or {}
    if isinstance(team, str):
        return {"id": None, "name": team, "rank": None, "gender": None}
    gender = team.get("gender") or team.get("genderCategory")
    if gender in ("M", "F"):
        pass
    elif isinstance(gender, str):
        gender = "F" if gender.upper().startswith("F") else "M" if gender else None
    birth_year = _birth_year_from_team(team)
    out = {
        "id": team.get("id"),
        "name": team.get("name") or team.get("shortName"),
        "shortName": team.get("shortName"),
        "rank": team.get("ranking") or team.get("rank"),
        "gender": gender,
        "country": (team.get("country") or {}).get("name")
        if isinstance(team.get("country"), dict)
        else team.get("country"),
    }
    if birth_year is not None:
        out["birthYear"] = birth_year
        out["age"] = 2026 - birth_year
    elif team.get("age") is not None and team.get("age") != "":
        try:
            out["age"] = int(float(team["age"]))
        except (TypeError, ValueError):
            pass
    return out


def _event_tour(ev: dict) -> str:
    unique = ev.get("uniqueTournament") or (ev.get("tournament") or {}).get("uniqueTournament") or {}
    cat = str((unique.get("category") or {}).get("slug") or (unique.get("category") or {}).get("name") or "")
    low = cat.lower()
    if "wta" in low:
        return "WTA"
    if "atp" in low or "challenger" in low:
        return "ATP"
    gender = _event_gender(ev)
    if gender == "F":
        return "WTA"
    if gender == "M":
        return "ATP"
    return (ev.get("tour") or "").upper()


def _event_gender(ev: dict) -> str | None:
    for side in ("home", "away"):
        g = _player_side(ev, side).get("gender")
        if g in ("M", "F"):
            return g
    unique = ev.get("uniqueTournament") or (ev.get("tournament") or {}).get("uniqueTournament") or {}
    cat = str((unique.get("category") or {}).get("slug") or (unique.get("category") or {}).get("name") or "").lower()
    if "wta" in cat or "women" in cat:
        return "F"
    if "atp" in cat or "men" in cat:
        return "M"
    return None


def round_label(info: dict | None) -> str | None:
    if not info or not isinstance(info, dict):
        return None
    for key in ("name", "round", "description"):
        val = info.get(key)
        if val:
            return str(val)
    cup = info.get("cupRoundType")
    return str(cup) if cup else None


_GROUND_LABELS = {
    "hardcourt": "硬地",
    "hard": "硬地",
    "clay": "红土",
    "grass": "草地",
    "carpet": "地毯",
    "indoor hard": "室内硬地",
    "indoor hardcourt": "室内硬地",
    "indoor clay": "室内红土",
}


def ground_label(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        raw = raw.get("name") or raw.get("description") or raw.get("type")
    s = str(raw or "").strip()
    if not s:
        return None
    low = s.lower().replace("_", " ")
    for key, label in _GROUND_LABELS.items():
        if key in low:
            return label
    return s


def tour_level_label(ev: dict, tour: str) -> str:
    unique = ev.get("uniqueTournament") or (ev.get("tournament") or {}).get("uniqueTournament") or {}
    name = str(unique.get("name") or unique.get("slug") or "").lower()
    tier = str(unique.get("category") or {}).lower() if isinstance(unique.get("category"), str) else ""
    points = unique.get("tennisPoints") or unique.get("userCount")
    prefix = (tour or _event_tour(ev) or "ATP").upper()
    if any(
        x in name
        for x in (
            "australian open",
            "roland garros",
            "french open",
            "wimbledon",
            "us open",
        )
    ) or "grand_slam" in tier or "grand slam" in tier:
        return f"{prefix} GS"
    if points is not None:
        try:
            p = int(points)
            if p >= 1000:
                return f"{prefix} 1000"
            if p >= 500:
                return f"{prefix} 500"
            if p >= 250:
                return f"{prefix} 250"
        except (TypeError, ValueError):
            pass
    if "1000" in name or "masters" in name:
        return f"{prefix} 1000"
    if "500" in name:
        return f"{prefix} 500"
    if "250" in name:
        return f"{prefix} 250"
    if "challenger" in name:
        return f"{prefix} CH"
    return prefix


def _is_ended(ev: dict) -> bool:
    st = ev.get("status") if isinstance(ev.get("status"), dict) else {}
    typ = str((st or {}).get("type") or ev.get("statusType") or "").lower()
    desc = str((st or {}).get("description") or ev.get("status") or "").lower()
    if typ in {"finished", "canceled", "cancelled"}:
        return True
    return any(k in desc for k in ("ended", "finished", "retired", "walkover", "cancel"))
