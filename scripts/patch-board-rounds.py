#!/usr/bin/env python3
from pathlib import Path

p = Path("/opt/yuce/bbbbb/board/quick_trade.py")
text = p.read_text(encoding="utf-8")

helper = '''

def _board_rounds_snapshot():
    """Per-timeframe round window + strike for board API consumers."""
    now = int(time.time())
    durations = {"5m": 300, "15m": 900, "1h": 3600}
    strikes = {"5m": 0.0, "15m": 0.0, "1h": 0.0}
    try:
        import onchain_leaderboard as olb
        with olb._btc_price_lock:
            strikes["5m"] = float(olb._btc_prices.get("strike") or 0)
            strikes["15m"] = float(olb._btc_prices.get("strike_15m") or 0)
            strikes["1h"] = float(olb._btc_prices.get("strike_1h") or 0)
    except Exception:
        pass
    rounds = {}
    with state_lock:
        s5_ts = int(state.get("round_ts") or 0)
        s5_end = int(state.get("round_end") or 0)
        s5_strike = float(state.get("strike") or 0)
        if s5_strike > 0:
            strikes["5m"] = s5_strike
    for tf, dur in durations.items():
        if tf == "5m" and s5_ts > 0:
            ts, end = s5_ts, (s5_end if s5_end > s5_ts else s5_ts + dur)
        else:
            ts = now - (now % dur)
            end = ts + dur
        rounds[tf] = {
            "round_ts": ts,
            "round_end": end,
            "strike": strikes.get(tf, 0.0),
        }
    return rounds

'''

anchor = "def _snapshot_state():"
if "_board_rounds_snapshot" not in text:
    if anchor not in text:
        raise SystemExit("anchor missing")
    text = text.replace(anchor, helper + anchor, 1)

old = """    try:
        import onchain_leaderboard as olb
        data["crawl_enabled"] = olb.is_crawl_enabled()
    except Exception:
        data["crawl_enabled"] = False
    # strip heavy / private fields for board consumers"""

new = """    try:
        import onchain_leaderboard as olb
        data["crawl_enabled"] = olb.is_crawl_enabled()
    except Exception:
        data["crawl_enabled"] = False
    try:
        data["board_rounds"] = _board_rounds_snapshot()
    except Exception:
        data["board_rounds"] = {}
    # strip heavy / private fields for board consumers"""

if old not in text:
    raise SystemExit("snapshot patch anchor missing")
text = text.replace(old, new, 1)
p.write_text(text, encoding="utf-8")
print("patched ok")
