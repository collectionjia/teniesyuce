"""监控采集结果写入 MySQL（tennis_events / odds / rankings / snapshot_meta）。"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tm.env import MONITOR_ROOT

APP_DIR = MONITOR_ROOT
ROOT_DIR = MONITOR_ROOT.parent.parent


def mysql_write_enabled() -> bool:
    """采集是否写入 MySQL，默认关闭（SOFA_WRITE_MYSQL=0）。"""
    return os.environ.get("SOFA_WRITE_MYSQL", "0").strip() == "1"


def collect_mysql_policy_message() -> str:
    if mysql_write_enabled():
        return "MySQL 写入已开启（SOFA_WRITE_MYSQL=1）"
    return "MySQL 写入已关闭（SOFA_WRITE_MYSQL=0），采集仅更新 bundle/Redis，不入库"


def log_collect_mysql_policy(label: str) -> str:
    line = f"[collect/{label}] {collect_mysql_policy_message()}"
    print(line)
    return line


def _load_db_env() -> None:
    candidates = [
        APP_DIR / "monitor.env",
        ROOT_DIR / "server" / ".env",
    ]
    for path in candidates:
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            if key.startswith("DB_") and key not in os.environ:
                os.environ[key] = val.strip().strip("\r").strip('"').strip("'")


def mysql_enabled() -> bool:
    _load_db_env()
    return bool(os.environ.get("DB_HOST") and os.environ.get("DB_NAME"))


def connect():
    _load_db_env()
    try:
        import pymysql
    except ImportError as exc:
        raise RuntimeError("缺少 pymysql，请 pip install pymysql") from exc

    host = os.environ.get("DB_HOST", "127.0.0.1")
    port = int(os.environ.get("DB_PORT", "3306"))
    user = os.environ.get("DB_USER", "root")
    password = os.environ.get("DB_PASSWORD", "")
    database = os.environ.get("DB_NAME", "tennisv2")
    return pymysql.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
        charset="utf8mb4",
        autocommit=False,
    )


def _num(v: Any) -> int | None:
    if v is None or v == "":
        return None
    if isinstance(v, dict):
        v = v.get("current")
    try:
        n = int(v)
        return n
    except (TypeError, ValueError):
        return None


def _dec(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _gender(v: Any) -> str | None:
    s = str(v or "").strip().upper()
    if not s:
        return None
    return s[0]


def _json(v: Any) -> str | None:
    if v is None:
        return None
    return json.dumps(v, ensure_ascii=False)


def _status_is_live(status: str | None, status_type: str | None) -> bool:
    st = str(status_type or "").lower()
    if st in {"inprogress", "live", "interrupted"}:
        return True
    low = str(status or "").lower()
    return any(k in low for k in ("live", "progress", "set", "进行"))


def _status_is_ended(status: str | None, status_type: str | None) -> bool:
    st = str(status_type or "").lower()
    if st in {"finished", "canceled", "cancelled"}:
        return True
    low = str(status or "").lower()
    return any(k in low for k in ("ended", "finished", "retired", "walkover", "cancel"))


def _norm_name(s: str | None) -> str:
    import unicodedata

    return unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower().strip()


def _event_match_date(ev: dict, fallback: str | None) -> str:
    ts = ev.get("startTimestamp")
    if ts:
        return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d")
    return fallback or datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _event_to_row(ev: dict, *, match_date: str) -> dict[str, Any]:
    home = ev.get("homePlayer") if isinstance(ev.get("homePlayer"), dict) else {}
    away = ev.get("awayPlayer") if isinstance(ev.get("awayPlayer"), dict) else {}
    if not home.get("name"):
        home = {"name": ev.get("home"), **home}
    if not away.get("name"):
        away = {"name": ev.get("away"), **away}
    status = ev.get("status")
    status_type = ev.get("statusType")
    return {
        "id": int(ev["id"]),
        "match_date": _event_match_date(ev, match_date),
        "tournament_row_id": None,
        "level": ev.get("level"),
        "tour": ev.get("tour"),
        "tennis_points": _num(ev.get("tennisPoints")),
        "tournament_name": ev.get("tournament"),
        "tournament_short": ev.get("tournamentShort") or ev.get("tournament"),
        "status": status,
        "status_type": status_type,
        "home_name": home.get("name") or ev.get("home"),
        "away_name": away.get("name") or ev.get("away"),
        "home_player_id": _num(home.get("id")),
        "away_player_id": _num(away.get("id")),
        "home_player_json": _json(home),
        "away_player_json": _json(away),
        "home_score": _num(ev.get("home_score") if ev.get("home_score") is not None else ev.get("homeScore")),
        "away_score": _num(ev.get("away_score") if ev.get("away_score") is not None else ev.get("awayScore")),
        "start_timestamp": _num(ev.get("startTimestamp")),
        "round_info_json": _json(ev.get("roundInfo")),
        "round_label": ev.get("roundLabel"),
        "ground_type": ev.get("groundType"),
        "ground_label": ev.get("groundLabel"),
        "gender": _gender(ev.get("gender") or home.get("gender") or away.get("gender")),
        "slug": ev.get("slug"),
        "custom_id": ev.get("customId"),
        "is_live": 1 if _status_is_live(status, status_type) else 0,
    }


def upsert_events(conn, events: list[dict], *, match_date: str) -> int:
    if not events:
        return 0
    sql = """
        INSERT INTO tennis_events (
            id, match_date, tournament_row_id, level, tour, tennis_points,
            tournament_name, tournament_short, status, status_type,
            home_name, away_name, home_player_id, away_player_id,
            home_player_json, away_player_json, home_score, away_score,
            start_timestamp, round_info_json, round_label, ground_type,
            ground_label, gender, slug, custom_id, is_live
        ) VALUES (
            %(id)s, %(match_date)s, %(tournament_row_id)s, %(level)s, %(tour)s, %(tennis_points)s,
            %(tournament_name)s, %(tournament_short)s, %(status)s, %(status_type)s,
            %(home_name)s, %(away_name)s, %(home_player_id)s, %(away_player_id)s,
            %(home_player_json)s, %(away_player_json)s, %(home_score)s, %(away_score)s,
            %(start_timestamp)s, %(round_info_json)s, %(round_label)s, %(ground_type)s,
            %(ground_label)s, %(gender)s, %(slug)s, %(custom_id)s, %(is_live)s
        )
        ON DUPLICATE KEY UPDATE
            match_date=VALUES(match_date),
            level=VALUES(level),
            tour=VALUES(tour),
            tennis_points=VALUES(tennis_points),
            tournament_name=VALUES(tournament_name),
            tournament_short=VALUES(tournament_short),
            status=VALUES(status),
            status_type=VALUES(status_type),
            home_name=VALUES(home_name),
            away_name=VALUES(away_name),
            home_player_id=VALUES(home_player_id),
            away_player_id=VALUES(away_player_id),
            home_player_json=VALUES(home_player_json),
            away_player_json=VALUES(away_player_json),
            home_score=VALUES(home_score),
            away_score=VALUES(away_score),
            start_timestamp=VALUES(start_timestamp),
            round_info_json=VALUES(round_info_json),
            round_label=VALUES(round_label),
            ground_type=VALUES(ground_type),
            ground_label=VALUES(ground_label),
            gender=VALUES(gender),
            slug=VALUES(slug),
            custom_id=VALUES(custom_id),
            is_live=VALUES(is_live)
    """
    rows = [_event_to_row(ev, match_date=match_date) for ev in events if ev.get("id") is not None]
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(sql, rows)
    return len(rows)


def upsert_odds(conn, odds_by_event: dict[str, Any]) -> int:
    if not odds_by_event:
        return 0
    sql = """
        INSERT INTO tennis_event_odds (
            event_id, market_name, is_live, suspended, source, bookmaker,
            sport_key, odds_event_id, home_decimal, away_decimal,
            home_initial_decimal, away_initial_decimal, home_change, away_change, raw_json
        ) VALUES (
            %(event_id)s, %(market_name)s, %(is_live)s, %(suspended)s, %(source)s, %(bookmaker)s,
            %(sport_key)s, %(odds_event_id)s, %(home_decimal)s, %(away_decimal)s,
            %(home_initial_decimal)s, %(away_initial_decimal)s, %(home_change)s, %(away_change)s, %(raw_json)s
        )
        ON DUPLICATE KEY UPDATE
            is_live=VALUES(is_live),
            suspended=VALUES(suspended),
            source=VALUES(source),
            home_decimal=VALUES(home_decimal),
            away_decimal=VALUES(away_decimal),
            home_initial_decimal=VALUES(home_initial_decimal),
            away_initial_decimal=VALUES(away_initial_decimal),
            home_change=VALUES(home_change),
            away_change=VALUES(away_change),
            raw_json=VALUES(raw_json)
    """
    payload: list[dict[str, Any]] = []
    for key, odds in odds_by_event.items():
        if not isinstance(odds, dict):
            continue
        ft = odds.get("full_time") or {}
        home = ft.get("home") or {}
        away = ft.get("away") or {}
        home_dec = _dec(home.get("decimal"))
        away_dec = _dec(away.get("decimal"))
        if home_dec is None and away_dec is None:
            continue
        payload.append(
            {
                "event_id": int(odds.get("eventId") or key),
                "market_name": "full_time",
                "is_live": 0,
                "suspended": 0,
                "source": odds.get("source") or ft.get("source") or "ipwo",
                "bookmaker": odds.get("bookmaker"),
                "sport_key": odds.get("sport_key"),
                "odds_event_id": str(odds.get("eventId") or key),
                "home_decimal": home_dec,
                "away_decimal": away_dec,
                "home_initial_decimal": _dec(home.get("initial")),
                "away_initial_decimal": _dec(away.get("initial")),
                "home_change": _num(home.get("change")) or 0,
                "away_change": _num(away.get("change")) or 0,
                "raw_json": _json(odds),
            }
        )
    if not payload:
        return 0
    with conn.cursor() as cur:
        cur.executemany(sql, payload)
    return len(payload)


def upsert_rankings(conn, rankings_by_player: dict[str, Any]) -> int:
    if not rankings_by_player:
        return 0
    sql = """
        INSERT INTO tennis_player_rankings (
            player_id, current_rank, previous_rank, best_rank, live_rank, utr, points, unavailable
        ) VALUES (
            %(player_id)s, %(current_rank)s, %(previous_rank)s, %(best_rank)s, %(live_rank)s,
            %(utr)s, %(points)s, %(unavailable)s
        )
        ON DUPLICATE KEY UPDATE
            current_rank=VALUES(current_rank),
            previous_rank=VALUES(previous_rank),
            best_rank=VALUES(best_rank),
            live_rank=VALUES(live_rank),
            utr=VALUES(utr),
            points=VALUES(points),
            unavailable=VALUES(unavailable),
            updated_at=CURRENT_TIMESTAMP
    """
    rows: list[dict[str, Any]] = []
    for pid, rank in rankings_by_player.items():
        if not isinstance(rank, dict):
            continue
        try:
            player_id = int(pid)
        except (TypeError, ValueError):
            continue
        rows.append(
            {
                "player_id": player_id,
                "current_rank": _num(rank.get("current")),
                "previous_rank": _num(rank.get("previous")),
                "best_rank": _num(rank.get("best")),
                "live_rank": _num(rank.get("live")),
                "utr": _dec(rank.get("utr")),
                "points": _num(rank.get("points")),
                "unavailable": 0,
            }
        )
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(sql, rows)
    return len(rows)


def upsert_snapshot_meta(conn, snapshot: dict[str, Any]) -> None:
    match_date = snapshot.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    fetched_at = snapshot.get("fetched_at")
    if fetched_at and "UTC" in str(fetched_at):
        fetched_at = str(fetched_at).replace(" UTC", "").strip()
    sql = """
        INSERT INTO tennis_snapshot_meta (
            id, sport, match_date, fetched_at, source, data_filter, top_rank_max, exclude_ended, update_json, filter_json
        ) VALUES (
            1, %(sport)s, %(match_date)s, %(fetched_at)s, %(source)s, %(data_filter)s,
            %(top_rank_max)s, %(exclude_ended)s, %(update_json)s, %(filter_json)s
        )
        ON DUPLICATE KEY UPDATE
            sport=VALUES(sport),
            match_date=VALUES(match_date),
            fetched_at=VALUES(fetched_at),
            source=VALUES(source),
            data_filter=VALUES(data_filter),
            top_rank_max=VALUES(top_rank_max),
            exclude_ended=VALUES(exclude_ended),
            update_json=VALUES(update_json),
            filter_json=VALUES(filter_json)
    """
    with conn.cursor() as cur:
        cur.execute(
            sql,
            {
                "sport": "tennis",
                "match_date": match_date,
                "fetched_at": fetched_at or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                "source": "sofascore-monitor",
                "data_filter": snapshot.get("filter") or "top100",
                "top_rank_max": _num(snapshot.get("top_rank_max")) or 100,
                "exclude_ended": 1,
                "update_json": _json(
                    {
                        "events": snapshot.get("total_events") or len(snapshot.get("events") or []),
                        "live": snapshot.get("live_count") or 0,
                        "elapsed_sec": snapshot.get("elapsed_sec"),
                        "collect_mode": snapshot.get("collect_mode"),
                    }
                ),
                "filter_json": _json([snapshot.get("filter") or "top100"]),
            },
        )


def update_live_events(conn, events: list[dict]) -> dict[str, int]:
    """按 Sofascore 事件 ID / 对阵名更新当日比赛状态与比分。"""
    updated = 0
    live_marked = 0
    ended_marked = 0
    live_ids: set[int] = set()

    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, home_name, away_name FROM tennis_events WHERE match_date >= CURDATE() - INTERVAL 1 DAY"
        )
        rows = cur.fetchall()
        by_name = {f"{_norm_name(r[1])}|{_norm_name(r[2])}": int(r[0]) for r in rows}

        for ev in events or []:
            eid = int(ev.get("id") or 0)
            if not eid:
                home = ev.get("home") or (ev.get("homePlayer") or {}).get("name")
                away = ev.get("away") or (ev.get("awayPlayer") or {}).get("name")
                eid = by_name.get(f"{_norm_name(home)}|{_norm_name(away)}") or 0
            if not eid:
                continue

            status = ev.get("status")
            status_type = ev.get("statusType")
            hs = _num(ev.get("home_score") if ev.get("home_score") is not None else ev.get("homeScore"))
            aws = _num(ev.get("away_score") if ev.get("away_score") is not None else ev.get("awayScore"))
            is_live = 1 if _status_is_live(status, status_type) else 0
            if is_live:
                live_ids.add(eid)

            cur.execute(
                """
                UPDATE tennis_events
                SET status=%s, status_type=%s, home_score=%s, away_score=%s, is_live=%s
                WHERE id=%s
                """,
                (status, status_type, hs, aws, is_live, eid),
            )
            if cur.rowcount:
                updated += 1
                if is_live:
                    live_marked += 1
                if _status_is_ended(status, status_type):
                    ended_marked += 1

        if live_ids:
            placeholders = ",".join(["%s"] * len(live_ids))
            cur.execute(
                f"""
                UPDATE tennis_events
                SET is_live=0, status='Ended', status_type='finished'
                WHERE is_live=1 AND id NOT IN ({placeholders})
                  AND match_date >= CURDATE() - INTERVAL 1 DAY
                """,
                tuple(live_ids),
            )
            ended_marked += cur.rowcount

    conn.commit()
    return {"updated": updated, "live": live_marked, "ended": ended_marked}


def write_snapshot_to_mysql(snapshot: dict[str, Any], *, live_only: bool = False) -> dict[str, Any]:
    if not mysql_write_enabled():
        return {"skipped": True, "reason": "SOFA_WRITE_MYSQL disabled"}
    if not mysql_enabled():
        return {"skipped": True, "reason": "DB not configured"}

    events = snapshot.get("events") or []
    match_date = snapshot.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = connect()
    try:
        if live_only:
            live_events = snapshot.get("live_matches") or events
            db = update_live_events(conn, live_events)
            odds_n = upsert_odds(conn, snapshot.get("oddsByEvent") or {})
            conn.commit()
            return {"live_only": True, **db, "odds": odds_n}

        events_n = upsert_events(conn, events, match_date=match_date)
        odds_n = upsert_odds(conn, snapshot.get("oddsByEvent") or {})
        ranks_n = upsert_rankings(conn, snapshot.get("rankingsByPlayer") or {})
        upsert_snapshot_meta(conn, snapshot)
        conn.commit()
        return {
            "events": events_n,
            "odds": odds_n,
            "rankings": ranks_n,
            "live_only": False,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
