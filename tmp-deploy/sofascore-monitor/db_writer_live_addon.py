
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
        by_name = {
            f"{_norm_name(r[1])}|{_norm_name(r[2])}": int(r[0])
            for r in rows
        }

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
            hs = ev.get("homeScore")
            aws = ev.get("awayScore")
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
