#!/usr/bin/env python3
"""Cap onchain scan batch size and resync when lag is too large."""
from pathlib import Path

p = Path("/opt/yuce/bbbbb/board/onchain_leaderboard.py")
text = p.read_text(encoding="utf-8")

old = """                current_block = w3.eth.block_number
                if scan_from > current_block:
                    time.sleep(1)
                    continue

                # 当回合过半，预取下一回合 token"""

new = """                current_block = w3.eth.block_number
                if scan_from > current_block:
                    time.sleep(1)
                    continue

                # 落后过多时重同步，避免一次扫十万块卡死
                lag = current_block - scan_from + 1
                max_lag = max(500, int(args.lookback))
                max_per_loop = 300
                if lag > max_lag:
                    lookback_blocks = max(50, int(args.lookback) // 2)
                    floor = max(0, current_block - lookback_blocks)
                    with _scan_lock:
                        _scan_state["last_scanned_block"] = floor
                        cumulative_balances.clear()
                        cumulative_blocks.clear()
                    scan_from = floor + 1
                    lag = current_block - scan_from + 1
                    print(
                        f"   ⚠️ 扫描落后过多，重同步到区块 {scan_from} (tip={current_block})",
                        flush=True,
                    )

                scan_to = min(current_block, scan_from + max_per_loop - 1)

                # 当回合过半，预取下一回合 token"""

old2 = """                quiet = (current_block - scan_from) < 10
                n_blocks = current_block - scan_from + 1
                logs = scan_transfers(w3, scan_from, current_block, quiet=quiet)"""

new2 = """                quiet = (scan_to - scan_from) < 10
                n_blocks = scan_to - scan_from + 1
                logs = scan_transfers(w3, scan_from, scan_to, quiet=quiet)"""

old3 = """                    _scan_state["last_scanned_block"] = current_block"""

new3 = """                    _scan_state["last_scanned_block"] = scan_to"""

for label, o, n in [("anchor1", old, new), ("anchor2", old2, new2), ("anchor3", old3, new3)]:
    if o not in text:
        raise SystemExit(f"missing {label}")
    text = text.replace(o, n, 1)

p.write_text(text, encoding="utf-8")
print("patched ok")
