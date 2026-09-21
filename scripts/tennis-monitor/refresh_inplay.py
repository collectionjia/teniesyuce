#!/usr/bin/env python3
"""轻量盘中刷新：只更新 Redis tennis:bundle:inplay 里已有场次。

- 比分/状态：Polymarket Gamma（event.score / live / ended）
- 赔率：Polymarket CLOB book mid（无盘口时回退 Gamma outcomePrices）
- 仅刷包内已有 polymarketByEvent（有 slug 的场次）；完赛迁入 settled

用法:
  python refresh_inplay.py
  python refresh_inplay.py --scores-only
  python refresh_inplay.py --odds-only
"""
from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

from tm.env import load_monitor_env

load_monitor_env()

from tm.bundle_store import (
    group_scheduled,
    is_ended_match,
    merge_finished_into_settled,
    read_live_bundle_redis,
    write_live_bundle_redis,
)
from tm.clients.polymarket import (
    apply_live_prices,
    apply_pm_settle_to_match,
    apply_sport_state_to_match,
    fetch_event_by_slug,
)


def _slug_of(poly: dict[str, Any]) -> str:
    slug = str(poly.get("slug") or "").strip()
    if slug:
        return slug
    url = str(poly.get("url") or "")
    if "polymarket.com/event/" in url:
        return url.split("polymarket.com/event/", 1)[1].split("?", 1)[0].split("#", 1)[0]
    return ""


def refresh_from_polymarket(
    matches: list[dict[str, Any]],
    poly_map: dict[str, Any],
    *,
    want_score: bool,
    want_odds: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """一次 Gamma 拉取同时刷新比分与赔率（CLOB mid）。"""
    scores: dict[str, Any] = {"updated": 0, "failed": 0, "skipped": not want_score}
    prices: dict[str, Any] = {"updated": 0, "failed": 0, "skipped": not want_odds}

    if not want_score and not want_odds:
        return scores, prices

    if not isinstance(poly_map, dict) or not poly_map:
        reason = "no polymarketByEvent"
        if want_score:
            scores.update({"skipped": True, "reason": reason, "ok": False})
        if want_odds:
            prices.update({"skipped": True, "reason": reason, "ok": False})
        return scores, prices

    by_id: dict[int, dict[str, Any]] = {
        int(m["id"]): m for m in matches if m.get("id") is not None
    }
    entries: list[tuple[str, int, dict[str, Any], str]] = []
    for eid, poly in poly_map.items():
        try:
            iid = int(eid)
        except (TypeError, ValueError):
            continue
        if iid not in by_id or not isinstance(poly, dict):
            continue
        slug = _slug_of(poly)
        if slug:
            entries.append((str(eid), iid, poly, slug))

    if not entries:
        reason = "no slugs"
        if want_score:
            scores.update({"skipped": True, "reason": reason, "tracked": len(by_id), "ok": False})
        if want_odds:
            prices.update({"skipped": True, "reason": reason, "ok": False})
        return scores, prices

    workers = max(1, min(4, int(os.environ.get("POLY_REFRESH_CONCURRENCY", "4"))))
    score_missed: list[dict[str, Any]] = []
    price_failures: list[dict[str, str]] = []

    def _one(
        item: tuple[str, int, dict[str, Any], str],
    ) -> tuple[str, int, dict[str, Any] | None, dict[str, Any] | None, str | None]:
        eid, iid, poly, slug = item
        try:
            ev = fetch_event_by_slug(slug)
            if not ev:
                return eid, iid, None, None, "empty"
            next_poly = apply_live_prices(poly, ev)
            return eid, iid, ev, next_poly, None
        except Exception as exc:
            return eid, iid, None, None, str(exc)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(_one, e) for e in entries]
        for fut in as_completed(futs):
            eid, iid, ev, next_poly, err = fut.result()
            match = by_id.get(iid)
            if err or not ev:
                reason = err or "no event"
                print(f"[refresh_inplay] poly fail id={eid}: {reason}", flush=True)
                if want_score:
                    scores["failed"] = int(scores.get("failed") or 0) + 1
                    score_missed.append(
                        {
                            "id": iid,
                            "home": (match or {}).get("home")
                            or ((match or {}).get("homePlayer") or {}).get("name"),
                            "away": (match or {}).get("away")
                            or ((match or {}).get("awayPlayer") or {}).get("name"),
                            "reason": reason,
                        }
                    )
                if want_odds:
                    prices["failed"] = int(prices.get("failed") or 0) + 1
                    price_failures.append({"id": eid, "reason": reason})
                continue

            if want_odds:
                if next_poly and (next_poly.get("moneyline") or {}).get("prices"):
                    poly_map[eid] = next_poly
                    prices["updated"] = int(prices.get("updated") or 0) + 1
                else:
                    prices["failed"] = int(prices.get("failed") or 0) + 1
                    price_failures.append({"id": eid, "reason": "no moneyline prices"})
                    print(f"[refresh_inplay] poly fail id={eid}: no moneyline prices", flush=True)
                    if next_poly:
                        poly_map[eid] = next_poly
            elif next_poly:
                poly_map[eid] = next_poly

            if want_score and match is not None:
                apply_sport_state_to_match(match, ev, poly=next_poly or poly_map.get(eid))
                scores["updated"] = int(scores.get("updated") or 0) + 1
            elif match is not None:
                apply_pm_settle_to_match(match, next_poly or poly_map.get(eid))
                if match.get("phaseMark") != "ended":
                    match["phaseMark"] = "live"
                    match["phaseLabel"] = "进行中"

    # 包内场次没有 polymarket slug 的算 miss（无法刷比分）
    if want_score:
        linked = {iid for _, iid, _, _ in entries}
        for iid, m in by_id.items():
            if iid in linked:
                continue
            scores["failed"] = int(scores.get("failed") or 0) + 1
            score_missed.append(
                {
                    "id": iid,
                    "home": m.get("home") or (m.get("homePlayer") or {}).get("name"),
                    "away": m.get("away") or (m.get("awayPlayer") or {}).get("name"),
                    "reason": "no polymarket slug",
                }
            )
        scores["tracked"] = len(by_id)
        scores["linked"] = len(entries)
        scores["missed"] = score_missed[:50]
        scores["ok"] = int(scores.get("updated") or 0) > 0
        scores["source"] = "polymarket-gamma"
        if score_missed:
            preview = score_missed[:20]
            print(
                f"[refresh_inplay] score miss {len(score_missed)}/{len(by_id)} "
                f"(poly_linked={len(entries)}): "
                + "; ".join(
                    f"{x['id']} {x.get('home') or '?'} vs {x.get('away') or '?'} ({x.get('reason')})"
                    for x in preview
                )
                + (" …" if len(score_missed) > len(preview) else ""),
                flush=True,
            )

    if want_odds:
        prices["candidates"] = len(entries)
        prices["failures"] = price_failures[:50]
        prices["ok"] = True
        prices["source"] = "polymarket-clob"
        if price_failures:
            print(
                f"[refresh_inplay] poly failed {len(price_failures)}/{len(entries)} "
                f"(updated={prices.get('updated')})",
                flush=True,
            )

    return scores, prices


def main() -> int:
    parser = argparse.ArgumentParser(description="只刷 Redis 盘中包：Polymarket 比分 + CLOB 赔率")
    parser.add_argument("--scores-only", action="store_true", help="只刷 Polymarket Gamma 比分/状态")
    parser.add_argument("--odds-only", action="store_true", help="只刷 Polymarket CLOB 赔率")
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
    print(f"[refresh_inplay] redis inplay matches={len(matches)}", flush=True)

    poly_map = bundle.get("polymarketByEvent")
    if not isinstance(poly_map, dict):
        poly_map = {}
        bundle["polymarketByEvent"] = poly_map

    scores, prices = refresh_from_polymarket(
        matches,
        poly_map,
        want_score=want_score,
        want_odds=want_odds,
    )
    moved: dict[str, Any] = {"moved": 0, "skipped": True}

    if want_score:
        still_live: list[dict[str, Any]] = []
        finished: list[dict[str, Any]] = []
        for m in matches:
            if is_ended_match(m):
                finished.append(m)
            else:
                still_live.append(m)

        if finished:
            moved = merge_finished_into_settled(finished, from_bundle=bundle)
            if moved.get("ok"):
                print(
                    f"[refresh_inplay] moved finished→settled "
                    f"{moved.get('moved')}/{len(matches)} "
                    f"(settled_total={moved.get('settled_matches')})",
                    flush=True,
                )
                finished_ids = {str(int(m["id"])) for m in finished if m.get("id") is not None}
                for meta_key in ("oddsByEvent", "polymarketByEvent", "eloByEvent"):
                    meta = bundle.get(meta_key)
                    if isinstance(meta, dict):
                        for kid in list(meta.keys()):
                            if str(kid) in finished_ids:
                                meta.pop(kid, None)
            else:
                print(
                    f"[refresh_inplay] move to settled failed: {moved.get('error')}",
                    flush=True,
                )
                still_live = matches
                finished = []

        matches = still_live
        live["matches"] = matches
        live["tournaments"] = group_scheduled(matches)["tournaments"]
        live["tournamentCount"] = len(live["tournaments"])
        live["eventCount"] = len(matches)
        bundle["live"] = live
        bundle["events"] = len(matches)
    else:
        live["matches"] = matches
        bundle["live"] = live

    now = datetime.now(timezone.utc).isoformat()
    bundle["tick_at"] = now
    bundle["serverTime"] = int(time.time())
    bundle["upstream"] = "polymarket"
    bundle["collectScript"] = "refresh_inplay"
    if want_score and not scores.get("skipped"):
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
            "moved_to_settled": moved,
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
        "moved_to_settled": moved,
        "score_updated_at": bundle.get("score_updated_at"),
        "odds_updated_at": bundle.get("odds_updated_at"),
    }
    print(
        f"[refresh_inplay] done scores={scores.get('updated')} "
        f"poly={prices.get('updated')}/{prices.get('failed', 0)} fail "
        f"moved={moved.get('moved', 0)} "
        f"in {summary['elapsed_sec']}s",
        flush=True,
    )
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
