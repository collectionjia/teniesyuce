#!/usr/bin/env python3
"""Fix board scan resync floor + default crawl enabled."""
from pathlib import Path

BOARD = Path("/opt/yuce/bbbbb/board/onchain_leaderboard.py")
COMPOSE = Path("/opt/yuce/bbbbb/docker-compose.external.yml")

text = BOARD.read_text(encoding="utf-8")

helper = '''def _scan_resync_floor(w3, tip_block: int, scan_state: dict, lookback_sec: int) -> int:
    """计算重同步起始区块：覆盖 5m/15m/1h 当前回合，且不超过 tip 回看窗口。"""
    now_ts = int(time.time())
    round_floor = ts_to_block(w3, scan_state["current_round_ts"] - lookback_sec)
    for duration in (900, 3600):
        tf_round = now_ts - (now_ts % duration)
        round_floor = min(round_floor, ts_to_block(w3, tf_round - lookback_sec))
    lookback_blocks = max(150, int(lookback_sec))
    tip_floor = max(0, tip_block - lookback_blocks)
    return max(0, min(round_floor, tip_floor) - 1)


'''

if "_scan_resync_floor" not in text:
    anchor = "    return max(estimated - 10, 0)  # 多往前 10 块确保不漏\n\n\n# ── 链上事件扫描"
    if anchor not in text:
        raise SystemExit("missing ts_to_block anchor")
    text = text.replace(anchor, "    return max(estimated - 10, 0)  # 多往前 10 块确保不漏\n\n\n" + helper + "# ── 链上事件扫描", 1)

old_enable = """            # 刚开启：若落后太多，跳到 tip-lookback，避免长时间补扫空块
            if not was_enabled:
                was_enabled = True
                try:
                    tip = w3.eth.block_number
                    lookback_blocks = max(50, int(args.lookback) // 2)
                    with _scan_lock:
                        floor = tip - lookback_blocks
                        if _scan_state["last_scanned_block"] < floor:
                            _scan_state["last_scanned_block"] = floor
                        start_at = _scan_state["last_scanned_block"] + 1
                    print(f"   🟢 爬取开启，从区块 {start_at} 追上 (tip={tip})", flush=True)
                except Exception as e:
                    print(f"   ⚠️ 爬取开启对齐区块失败: {e}", flush=True)"""

new_enable = """            # 刚开启：从本回合起点重扫，避免跳过关闭期间区块导致持仓为空
            if not was_enabled:
                was_enabled = True
                try:
                    tip = w3.eth.block_number
                    with _scan_lock:
                        floor = _scan_resync_floor(w3, tip, _scan_state, args.lookback)
                        if _scan_state["last_scanned_block"] < floor:
                            _scan_state["last_scanned_block"] = floor
                            cumulative_balances.clear()
                            cumulative_blocks.clear()
                        start_at = _scan_state["last_scanned_block"] + 1
                    print(f"   🟢 爬取开启，从区块 {start_at} 追上 (tip={tip})", flush=True)
                except Exception as e:
                    print(f"   ⚠️ 爬取开启对齐区块失败: {e}", flush=True)"""

old_resync = """                if lag > max_lag:
                    lookback_blocks = max(50, int(args.lookback) // 2)
                    floor = max(0, current_block - lookback_blocks)
                    with _scan_lock:
                        _scan_state["last_scanned_block"] = floor
                        cumulative_balances.clear()
                        cumulative_blocks.clear()
                    scan_from = floor + 1"""

new_resync = """                if lag > max_lag:
                    with _scan_lock:
                        floor = _scan_resync_floor(w3, current_block, _scan_state, args.lookback)
                        _scan_state["last_scanned_block"] = floor
                        cumulative_balances.clear()
                        cumulative_blocks.clear()
                    scan_from = floor + 1"""

for label, old, new in [("enable", old_enable, new_enable), ("resync", old_resync, new_resync)]:
    if old not in text:
        if new.split("\n", 1)[0] in text:
            print(f"skip {label}, already patched")
            continue
        raise SystemExit(f"missing {label} block")
    text = text.replace(old, new, 1)

BOARD.write_text(text, encoding="utf-8")
print("patched board ok")

if COMPOSE.exists():
    c = COMPOSE.read_text(encoding="utf-8")
    c2 = c.replace("CRAWL_ENABLED: ${CRAWL_ENABLED:-false}", "CRAWL_ENABLED: ${CRAWL_ENABLED:-true}")
    if c2 != c:
        COMPOSE.write_text(c2, encoding="utf-8")
        print("patched compose crawl default")
    else:
        print("compose already ok")
