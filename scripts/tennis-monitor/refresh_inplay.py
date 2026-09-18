#!/usr/bin/env python3
"""轻量盘中刷新：只更新 Redis tennis:bundle:inplay 里已有场次。

- 比分/状态：Sofascore live（仅匹配包内 event id，不扩容新赛）
- 赔率：Polymarket Gamma API（仅刷包内已有 polymarketByEvent）

用法:
  python refresh_inplay.py
  python refresh_inplay.py --scores-only
  python refresh_inplay.py --odds-only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

from tm.env import load_monitor_env

load_monitor_env()

from tm.bundle_store import group_scheduled, read_live_bundle_redis, write_live_bundle_redis
from tm.clients.polymarket import apply_live_prices, fetch_event_by_slug
from tm.clients.sofascore import SofascoreClient, _event_score


def _slug_of(poly: dict[str, Any]) -> str:
    slug = str(poly.get("slug") or "").strip()
    if slug:
        return slug
    url = str(poly.get("url") or "")
    if "polymarket.com/event/" in url:
        return url.split("polymarket.com/event/", 1)[1].split("?", 1)[0].split("#", 1)[0]
    return ""


def _patch_match_score(match: dict[str, Any], raw: dict[str, Any]) -> None:
    status = raw.get("status") if isinstance(raw.get("status"), dict) else {}
    match["status"] = status.get("description") or match.get("status")
    match["statusType"] = status.get("type") or match.get("statusType")
    match["homeScore"] = raw.get("homeScore")
    match["awayScore"] = raw.get("awayScore")
    hs = raw.get("homeScore") if isinstance(raw.get("homeScore"), dict) else {}
    aws = raw.get("awayScore") if isinstance(raw.get("awayScore"), dict) else {}
    if hs.get("current") is not None:
        match["home_score"] = hs.get("current")
    if aws.get("current") is not None:
        match["away_score"] = aws.get("current")
    score = _event_score(raw)
    if score:
        match["scoreText"] = score


def refresh_scores(matches: list[dict[str, Any]]) -> dict[str, Any]:
    want = {int(m["id"]) for m in matches if m.get("id") is not None}
    if not want:
        return {"updated": 0, "live_feed": 0, "skipped": True, "reason": "no match ids"}

    skip_warm = os.environ.get("SOFA_SKIP_WARM_ON_LIVE", "1") == "1"
    error: str | None = None
    live_raw: list[dict] = []
    try:
        with SofascoreClient(skip_warm=skip_warm) as client:
            try:
                live_raw = list((client.get_live_tennis_events().get("events") or []))
            except Exception as exc:
                error = str(exc)
                print(f"[refresh_inplay] Sofascore live failed: {error}", flush=True)
    except Exception as exc:
        # curl_cffi / 代理未配置等：Client 初始化失败也要落成 scores.error，避免整脚本崩掉
        error = str(exc)
        print(f"[refresh_inplay] Sofascore client failed: {error}", flush=True)
        return {
            "updated": 0,
            "failed": len(want),
            "live_feed": 0,
            "tracked": len(want),
            "missed": [],
            "error": error,
            "ok": False,
        }

    by_id = {int(ev["id"]): ev for ev in live_raw if ev.get("id") is not None}
    updated = 0
    missed: list[dict[str, Any]] = []
    for m in matches:
        eid = m.get("id")
        if eid is None:
            continue
        iid = int(eid)
        raw = by_id.get(iid)
        if not raw:
            missed.append(
                {
                    "id": iid,
                    "home": m.get("home") or (m.get("homePlayer") or {}).get("name"),
                    "away": m.get("away") or (m.get("awayPlayer") or {}).get("name"),
                    "status": m.get("status") or m.get("statusType"),
                    "reason": "not in Sofascore live feed",
                }
            )
            continue
        _patch_match_score(m, raw)
        updated += 1

    if missed:
        preview = missed[:20]
        print(
            f"[refresh_inplay] score miss {len(missed)}/{len(want)} "
            f"(live_feed={len(live_raw)}): "
            + "; ".join(
                f"{x['id']} {x.get('home') or '?'} vs {x.get('away') or '?'} ({x.get('reason')})"
                for x in preview
            )
            + (" …" if len(missed) > len(preview) else ""),
            flush=True,
        )
    if error:
        print(
            f"[refresh_inplay] score failed: error={error} "
            f"updated={updated}/{len(want)} live_feed={len(live_raw)}",
            flush=True,
        )
    elif updated == 0 and want:
        print(
            f"[refresh_inplay] score failed: updated=0/{len(want)} "
            f"live_feed={len(live_raw)} missed={len(missed)}",
            flush=True,
        )

    return {
        "updated": updated,
        "failed": len(missed),
        "live_feed": len(live_raw),
        "tracked": len(want),
        "missed": missed[:50],
        "error": error,
        "ok": error is None,
    }


def refresh_polymarket(poly_map: dict[str, Any], match_ids: set[int]) -> dict[str, Any]:
    if not isinstance(poly_map, dict) or not poly_map:
        return {"updated": 0, "failed": 0, "skipped": True, "reason": "no polymarketByEvent"}

    entries: list[tuple[str, dict[str, Any], str]] = []
    for eid, poly in poly_map.items():
        try:
            iid = int(eid)
        except (TypeError, ValueError):
            continue
        if match_ids and iid not in match_ids:
            continue
        if not isinstance(poly, dict):
            continue
        slug = _slug_of(poly)
        if slug:
            entries.append((str(eid), poly, slug))

    if not entries:
        return {"updated": 0, "failed": 0, "skipped": True, "reason": "no slugs"}

    updated = 0
    failed = 0
    workers = max(1, min(4, int(os.environ.get("POLY_REFRESH_CONCURRENCY", "4"))))

    def _one(item: tuple[str, dict[str, Any], str]) -> tuple[str, dict[str, Any] | None, str | None]:
        eid, poly, slug = item
        try:
            ev = fetch_event_by_slug(slug)
            if not ev:
                return eid, None, "empty"
            return eid, apply_live_prices(poly, ev), None
        except Exception as exc:
            return eid, None, str(exc)

    failures: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(_one, e) for e in entries]
        for fut in as_completed(futs):
            eid, next_poly, err = fut.result()
            if err or not next_poly:
                failed += 1
                reason = err or "no event"
                failures.append({"id": eid, "reason": reason})
                print(f"[refresh_inplay] poly fail id={eid}: {reason}", flush=True)
                continue
            if next_poly.get("moneyline", {}).get("prices"):
                poly_map[eid] = next_poly
                updated += 1
            else:
                failed += 1
                reason = "no moneyline prices"
                failures.append({"id": eid, "reason": reason})
                print(f"[refresh_inplay] poly fail id={eid}: {reason}", flush=True)

    if failed:
        print(
            f"[refresh_inplay] poly failed {failed}/{len(entries)} "
            f"(updated={updated})",
            flush=True,
        )

    return {
        "updated": updated,
        "failed": failed,
        "candidates": len(entries),
        "failures": failures[:50],
        "ok": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="只刷 Redis 盘中包比分 + Polymarket 赔率")
    parser.add_argument("--scores-only", action="store_true", help="只刷 Sofascore 比分")
    parser.add_argument("--odds-only", action="store_true", help="只刷 Polymarket 赔率")
    args = parser.parse_args()
    want_score = not args.odds_only
    want_odds = not args.scores_only

    started = time.time()
    loaded = read_live_bundle_redis()
    if not loaded.get("ok"):
        summary = {"ok": False, "error": loaded.get("error") or loaded.get("reason") or "redis read failed"}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return 1

    bundle = loaded.get("bundle")
    if not bundle:
        summary = {
            "ok": True,
            "skipped": True,
            "reason": "empty inplay bundle",
            "scores": {"updated": 0},
            "prices": {"updated": 0, "failed": 0},
        }
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
        return 0

    live = bundle.get("live") if isinstance(bundle.get("live"), dict) else {}
    matches = list(live.get("matches") or [])
    match_ids = {int(m["id"]) for m in matches if m.get("id") is not None}
    print(f"[refresh_inplay] redis inplay matches={len(matches)}", flush=True)

    scores: dict[str, Any] = {"updated": 0, "skipped": True}
    prices: dict[str, Any] = {"updated": 0, "failed": 0, "skipped": True}

    if want_score:
        scores = refresh_scores(matches)
        live["matches"] = matches
        live["tournaments"] = group_scheduled(matches)["tournaments"]
        live["tournamentCount"] = len(live["tournaments"])
        live["eventCount"] = len(matches)
        bundle["live"] = live

    if want_odds:
        poly_map = bundle.get("polymarketByEvent")
        if not isinstance(poly_map, dict):
            poly_map = {}
            bundle["polymarketByEvent"] = poly_map
        prices = refresh_polymarket(poly_map, match_ids)

    now = datetime.now(timezone.utc).isoformat()
    bundle["tick_at"] = now
    bundle["serverTime"] = int(time.time())
    bundle["upstream"] = "ipwo"
    bundle["collectScript"] = "refresh_inplay"
    if want_score and scores.get("updated", 0) >= 0 and not scores.get("skipped"):
        bundle["score_updated_at"] = now
    if want_odds and not prices.get("skipped"):
        bundle["odds_updated_at"] = now

    written = write_live_bundle_redis(bundle)
    if not written.get("ok"):
        summary = {
            "ok": False,
            "error": written.get("error") or written.get("reason") or "redis write failed",
            "scores": scores,
            "prices": prices,
        }
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
        return 1

    summary = {
        "ok": True,
        "elapsed_sec": round(time.time() - started, 2),
        "inplay_matches": len(matches),
        "scores": scores,
        "prices": prices,
        "score_updated_at": bundle.get("score_updated_at"),
        "odds_updated_at": bundle.get("odds_updated_at"),
    }
    print(
        f"[refresh_inplay] done scores={scores.get('updated')} "
        f"poly={prices.get('updated')}/{prices.get('failed', 0)} fail "
        f"in {summary['elapsed_sec']}s",
        flush=True,
    )
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
    # 写 Redis 成功即 0；比分/赔率局部失败写在 summary 里供 tick 展示
    return 0


if __name__ == "__main__":
    sys.exit(main())
