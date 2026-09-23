#!/usr/bin/env python3
"""轻量盘中刷新：只更新 Redis tennis:bundle:inplay 里已有场次。

- 比分/状态：Sofascore（经 IPWO）；**仅有 Polymarket 外链的场次**
- 赔率：Polymarket Gamma + CLOB mid（直连，不走 IPWO）
- 仅刷包内已有场次；完赛迁入 settled

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
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from tm.env import load_monitor_env

load_monitor_env()

from tm.bundle import slim_event
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
    fetch_event_by_slug,
)
from tm.clients.sofascore import SofascoreClient


def _slug_of(poly: dict[str, Any]) -> str:
    slug = str(poly.get("slug") or "").strip()
    if slug:
        return slug
    url = str(poly.get("url") or "")
    if "polymarket.com/event/" in url:
        return url.split("polymarket.com/event/", 1)[1].split("?", 1)[0].split("#", 1)[0]
    return ""


def _match_label(match: dict[str, Any] | None) -> tuple[Any, Any]:
    if not match:
        return "?", "?"
    home = match.get("home") or ((match.get("homePlayer") or {}).get("name"))
    away = match.get("away") or ((match.get("awayPlayer") or {}).get("name"))
    return home or "?", away or "?"


def _apply_sofa_slim_to_match(match: dict[str, Any], slim: dict[str, Any]) -> None:
    """把 Sofascore slim 字段写回包内 match（保留原有球员/元数据）。"""
    for key in (
        "status",
        "statusType",
        "homeScore",
        "awayScore",
        "home_score",
        "away_score",
        "scoreText",
        "slug",
        "customId",
        "url",
    ):
        if slim.get(key) is not None:
            match[key] = slim[key]

    st = str(match.get("statusType") or "").lower().strip()
    if st in {"finished", "ended"}:
        match["phaseMark"] = "ended"
        match["phaseLabel"] = "已结束"
    elif st in {"inprogress", "paused", "interrupted"}:
        match["phaseMark"] = "live"
        match["phaseLabel"] = "进行中"
    elif st == "notstarted":
        match["phaseMark"] = "not_started"
        match["phaseLabel"] = "未开赛"


def _poly_of(poly_map: dict[str, Any] | None, eid: int | str) -> dict[str, Any] | None:
    if not isinstance(poly_map, dict):
        return None
    poly = poly_map.get(str(eid)) or poly_map.get(eid)
    return poly if isinstance(poly, dict) else None


def _has_external_link(match: dict[str, Any], poly_map: dict[str, Any] | None) -> bool:
    """有 Polymarket 外链（slug/url）才刷分。"""
    poly = _poly_of(poly_map, match.get("id"))
    if poly and _slug_of(poly):
        return True
    url = str((poly or {}).get("url") or match.get("polymarketUrl") or "").strip()
    return "polymarket.com/event/" in url


def refresh_scores_sofascore(
    matches: list[dict[str, Any]],
    poly_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """IPWO → Sofascore：只刷「有外链」的包内场次比分/状态。"""
    scores: dict[str, Any] = {
        "updated": 0,
        "failed": 0,
        "skipped": False,
        "source": "sofascore-ipwo",
        "upstream": "ipwo",
    }
    if not matches:
        scores.update({"skipped": True, "reason": "no matches", "ok": True})
        return scores

    by_id: dict[int, dict[str, Any]] = {
        int(m["id"]): m for m in matches if m.get("id") is not None
    }
    linked: dict[int, dict[str, Any]] = {
        iid: m for iid, m in by_id.items() if _has_external_link(m, poly_map)
    }
    no_link = len(by_id) - len(linked)
    scores["no_link_skipped"] = no_link

    if not linked:
        scores.update(
            {
                "skipped": True,
                "reason": "no external link (polymarket)",
                "tracked": 0,
                "bundle_matches": len(by_id),
                "ok": True,
            }
        )
        print(
            f"[refresh_inplay] scores skipped: no external link "
            f"(bundle={len(by_id)} no_link={no_link})",
            flush=True,
        )
        return scores

    # 确保盘中任务走代理开关（Sofascore 侧 require_proxy）
    os.environ.setdefault("COLLECT_PROXY_JOB", "inplay")
    if not (os.environ.get("COLLECT_INPLAY_USE_PROXY") or "").strip():
        os.environ["COLLECT_INPLAY_USE_PROXY"] = "1"

    missed: list[dict[str, Any]] = []
    live_hit = 0
    detail_hit = 0

    try:
        with SofascoreClient(skip_warm=os.environ.get("SOFA_SKIP_WARM_ON_LIVE", "1") == "1") as client:
            live_by_id: dict[int, dict[str, Any]] = {}
            try:
                for ev in client.get_live_tennis_events().get("events") or []:
                    if ev.get("id") is None:
                        continue
                    try:
                        live_by_id[int(ev["id"])] = ev
                    except (TypeError, ValueError):
                        continue
            except Exception as exc:
                print(f"[refresh_inplay] sofa live list failed: {exc}", flush=True)

            for iid, match in linked.items():
                home, away = _match_label(match)
                try:
                    raw = live_by_id.get(iid)
                    if raw is not None:
                        live_hit += 1
                    else:
                        payload = client.get_event(iid)
                        inner = payload.get("event") if isinstance(payload, dict) else None
                        if not isinstance(inner, dict):
                            raise RuntimeError("empty event payload")
                        raw = inner
                        detail_hit += 1
                    slim = slim_event(raw)
                    _apply_sofa_slim_to_match(match, slim)
                    scores["updated"] = int(scores.get("updated") or 0) + 1
                except Exception as exc:
                    scores["failed"] = int(scores.get("failed") or 0) + 1
                    missed.append({"id": iid, "home": home, "away": away, "reason": str(exc)})
                    print(f"[refresh_inplay] sofa fail id={iid}: {exc}", flush=True)
    except Exception as exc:
        scores.update(
            {
                "ok": False,
                "error": str(exc),
                "tracked": len(linked),
                "missed": missed[:50],
            }
        )
        print(f"[refresh_inplay] sofa client failed: {exc}", flush=True)
        return scores

    scores["tracked"] = len(linked)
    scores["bundle_matches"] = len(by_id)
    scores["live_feed"] = live_hit
    scores["detail_fetch"] = detail_hit
    scores["missed"] = missed[:50]
    scores["ok"] = int(scores.get("updated") or 0) > 0 or len(linked) == 0
    if missed:
        preview = missed[:20]
        print(
            f"[refresh_inplay] score miss {len(missed)}/{len(linked)} "
            f"(live={live_hit} detail={detail_hit} no_link={no_link}): "
            + "; ".join(
                f"{x['id']} {x.get('home') or '?'} vs {x.get('away') or '?'} ({x.get('reason')})"
                for x in preview
            )
            + (" …" if len(missed) > len(preview) else ""),
            flush=True,
        )
    else:
        print(
            f"[refresh_inplay] scores ok updated={scores.get('updated')} "
            f"linked={len(linked)} no_link={no_link} live={live_hit} detail={detail_hit}",
            flush=True,
        )
    return scores


@contextmanager
def _polymarket_direct():
    """赔率直连：临时关掉盘中代理开关，避免 proxies_for('Polymarket') 套 IPWO。"""
    key = "COLLECT_INPLAY_USE_PROXY"
    prev = os.environ.get(key)
    os.environ[key] = "0"
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


def refresh_odds_polymarket(
    matches: list[dict[str, Any]],
    poly_map: dict[str, Any],
) -> dict[str, Any]:
    """Polymarket 直连：只刷有 slug 的场次赔率（不写比分）。"""
    prices: dict[str, Any] = {
        "updated": 0,
        "failed": 0,
        "skipped": False,
        "source": "polymarket-clob",
        "upstream": "polymarket-direct",
    }

    if not isinstance(poly_map, dict) or not poly_map:
        prices.update({"skipped": True, "reason": "no polymarketByEvent", "ok": False})
        return prices

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
        prices.update({"skipped": True, "reason": "no slugs", "ok": True, "candidates": 0})
        return prices

    workers = max(1, min(4, int(os.environ.get("POLY_REFRESH_CONCURRENCY", "4"))))
    price_failures: list[dict[str, str]] = []

    def _one(
        item: tuple[str, int, dict[str, Any], str],
    ) -> tuple[str, int, dict[str, Any] | None, str | None]:
        eid, iid, poly, slug = item
        try:
            ev = fetch_event_by_slug(slug)
            if not ev:
                return eid, iid, None, "empty"
            return eid, iid, apply_live_prices(poly, ev), None
        except Exception as exc:
            return eid, iid, None, str(exc)

    with _polymarket_direct():
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(_one, e) for e in entries]
            for fut in as_completed(futs):
                eid, iid, next_poly, err = fut.result()
                match = by_id.get(iid)
                if err or not next_poly:
                    reason = err or "no event"
                    prices["failed"] = int(prices.get("failed") or 0) + 1
                    price_failures.append({"id": eid, "reason": reason})
                    print(f"[refresh_inplay] poly fail id={eid}: {reason}", flush=True)
                    continue
                if (next_poly.get("moneyline") or {}).get("prices"):
                    poly_map[eid] = next_poly
                    prices["updated"] = int(prices.get("updated") or 0) + 1
                else:
                    prices["failed"] = int(prices.get("failed") or 0) + 1
                    price_failures.append({"id": eid, "reason": "no moneyline prices"})
                    print(f"[refresh_inplay] poly fail id={eid}: no moneyline prices", flush=True)
                    poly_map[eid] = next_poly
                if match is not None:
                    apply_pm_settle_to_match(match, poly_map.get(eid))
                    if match.get("phaseMark") != "ended" and str(match.get("statusType") or "").lower() in {
                        "inprogress",
                        "paused",
                        "interrupted",
                    }:
                        match["phaseMark"] = "live"
                        match["phaseLabel"] = "进行中"

    prices["candidates"] = len(entries)
    prices["failures"] = price_failures[:50]
    prices["ok"] = True
    if price_failures:
        print(
            f"[refresh_inplay] poly failed {len(price_failures)}/{len(entries)} "
            f"(updated={prices.get('updated')})",
            flush=True,
        )
    return prices


def main() -> int:
    parser = argparse.ArgumentParser(
        description="只刷 Redis 盘中包：Sofascore(IPWO) 比分 + Polymarket 直连赔率"
    )
    parser.add_argument("--scores-only", action="store_true", help="只刷 Sofascore 比分/状态")
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

    scores: dict[str, Any] = {"updated": 0, "failed": 0, "skipped": True}
    prices: dict[str, Any] = {"updated": 0, "failed": 0, "skipped": True}

    if want_score:
        scores = refresh_scores_sofascore(matches, poly_map)
    if want_odds:
        prices = refresh_odds_polymarket(matches, poly_map)

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
    bundle["upstream"] = "ipwo+polymarket"
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
