#!/usr/bin/env python3
"""
onchain_leaderboard.py — 链上持仓排行榜 (实时 Top 20)

通过扫描 CTF 合约的 TransferSingle 事件重建每个地址的净持仓，
包括 maker + taker + 直接转账，解决 DATA-API 只显示 taker 的问题。

用法:
    python3 onchain_leaderboard.py              # 实时监控当前回合
    python3 onchain_leaderboard.py --once        # 只查一次
    python3 onchain_leaderboard.py --ts 1775757000  # 指定回合时间戳
"""

import json
import os
import sys
import time
import threading
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import requests
from dotenv import load_dotenv
from web3 import Web3

load_dotenv()

# ── 配置 ──────────────────────────────────────────────────────────────────────
CTF_ADDR = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
TRANSFER_SINGLE_TOPIC = Web3.keccak(
    text="TransferSingle(address,address,address,uint256,uint256)"
)
ZERO_ADDR = "0x" + "0" * 40
ROUND_DURATION = 300  # 5 分钟

ALCHEMY_KEY = os.getenv("ALCHEMY_KEY", "")
RPC_URL = f"https://polygon-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"

# 过滤做市商: 双向持仓地址不进入排行榜 (默认开启)
FILTER_MARKET_MAKERS = os.getenv("FILTER_MARKET_MAKERS", "true").lower() in ("1", "true", "yes")

# 连胜阈值: 连续 N 回合押中赢家方向才标记 🔥
STREAK_MIN_ROUNDS = max(2, int(os.getenv("STREAK_MIN_ROUNDS", "3")))

# 链上爬取开关: 默认关闭，看板 UI / API 开启后才扫块
CRAWL_STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "持仓", "crawl_enabled.json")
_crawl_enabled = threading.Event()
_crawl_lock = threading.Lock()


def _load_crawl_enabled_default() -> bool:
    env = os.getenv("CRAWL_ENABLED", "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        default = True
    elif env in ("0", "false", "no", "off"):
        default = False
    else:
        default = False
    try:
        if os.path.isfile(CRAWL_STATE_FILE):
            with open(CRAWL_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return bool(data.get("enabled", default))
    except Exception:
        pass
    return default


def is_crawl_enabled() -> bool:
    return _crawl_enabled.is_set()


def set_crawl_enabled(enabled: bool) -> bool:
    """开启/关闭链上扫块。状态写入磁盘，进程重启后保留。"""
    with _crawl_lock:
        if enabled:
            _crawl_enabled.set()
        else:
            _crawl_enabled.clear()
        try:
            os.makedirs(os.path.dirname(CRAWL_STATE_FILE), exist_ok=True)
            with open(CRAWL_STATE_FILE, "w", encoding="utf-8") as f:
                json.dump({"enabled": bool(enabled)}, f, ensure_ascii=False)
        except Exception as e:
            print(f"  ⚠️ 保存爬取开关失败: {e}", flush=True)
        print(
            f"  {'🟢' if enabled else '⏸'} 链上爬取已{'开启' if enabled else '关闭'}",
            flush=True,
        )
    return is_crawl_enabled()


if _load_crawl_enabled_default():
    _crawl_enabled.set()

# 已跟踪的鲸鱼 (从外部文件加载, 修改文件后下个回合自动生效)
WHALES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tracked_whales_list.txt")
TRACKED_WHALES = set()
# Checksum 处理
TRACKED_WHALES_CS = set()


def reload_tracked_whales():
    """从 tracked_whales_list.txt 重载鲸鱼地址列表 (无需重启)"""
    global TRACKED_WHALES, TRACKED_WHALES_CS
    addrs = set()
    try:
        with open(WHALES_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("0x") and len(line) >= 42:
                    addrs.add(line[:42])
    except FileNotFoundError:
        print(f"⚠️ 鲸鱼列表文件不存在: {WHALES_FILE}")
        return
    old_count = len(TRACKED_WHALES)
    TRACKED_WHALES = addrs
    try:
        from web3 import Web3
        TRACKED_WHALES_CS = {Web3.to_checksum_address(a) for a in TRACKED_WHALES}
    except Exception:
        TRACKED_WHALES_CS = TRACKED_WHALES.copy()
    new_count = len(TRACKED_WHALES)
    if new_count != old_count:
        print(f"🐋 鲸鱼列表已重载: {old_count} → {new_count} 个地址")

# 用户数据缓存: {addr_lower: {"name": str, "pnl": float|None, "ts": float}}
_user_cache = {}
_PNL_REFRESH_INTERVAL = 86400  # 鲸鱼 PnL 每天刷新一次
CACHE_FILE = os.path.join(os.path.dirname(__file__), "username_cache.json")


def load_username_cache():
    global _user_cache
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, "r") as f:
                raw = json.load(f)
            for k, v in raw.items():
                if isinstance(v, dict):
                    # 只保留有实际数据的条目
                    if v.get("name") or v.get("pnl") is not None:
                        _user_cache[k] = v
                elif isinstance(v, str) and v:
                    _user_cache[k] = {"name": v, "pnl": None}
    except Exception:
        pass


def save_username_cache():
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(_user_cache, f, ensure_ascii=False)
    except Exception:
        pass


def _fetch_user_info(addr_lower: str) -> dict:
    """从 Polymarket 获取用户名 + PnL"""
    import re
    info = {"name": "", "pnl": None}

    # 1. userData API → 用户名
    try:
        r = requests.get(
            f"https://polymarket.com/api/profile/userData?address={addr_lower}",
            timeout=5, verify=False,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        if r.status_code == 200:
            data = r.json()
            info["name"] = data.get("name") or data.get("pseudonym") or ""
    except Exception:
        pass

    # 2. profile HTML → PnL
    try:
        r = requests.get(
            f"https://polymarket.com/profile/{addr_lower}",
            timeout=10, verify=False,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        m = re.search(r'"pnl"\s*:\s*(\-?\d+(?:\.\d+)?)', r.text)
        if m:
            info["pnl"] = float(m.group(1))
    except Exception:
        pass

    return info


def get_user_info(addr: str) -> dict:
    """非阻塞: 从缓存读取用户数据, 无缓存则提交队列"""
    addr_lower = addr.lower()
    if addr_lower in _user_cache:
        return _user_cache[addr_lower]
    _user_resolve_queue.add(addr_lower)
    return {"name": "", "pnl": None}


_user_resolve_queue = set()

def _user_resolver_worker():
    """后台线程: 批量解析用户信息 (name + pnl)"""
    while True:
        # 处理新地址
        if _user_resolve_queue:
            addr = _user_resolve_queue.pop()
            if addr not in _user_cache:
                info = _fetch_user_info(addr)
                info["ts"] = time.time()
                _user_cache[addr] = info
            time.sleep(0.3)
            continue

        # 空闲时刷新过期的鲸鱼 PnL
        now = time.time()
        stale = None
        for addr in TRACKED_WHALES_CS:
            a = addr.lower()
            entry = _user_cache.get(a)
            if entry and now - entry.get("ts", 0) > _PNL_REFRESH_INTERVAL:
                stale = a
                break
        if stale:
            info = _fetch_user_info(stale)
            info["ts"] = time.time()
            _user_cache[stale] = info
            time.sleep(0.3)
        else:
            time.sleep(2)


# ── Web3 连接 ──────────────────────────────────────────────────────────────────
def get_w3():
    try:
        from web3.middleware import ExtraDataToPOAMiddleware as POA
    except ImportError:
        try:
            from web3.middleware import geth_poa_middleware as POA
        except ImportError:
            POA = None

    w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
    if POA:
        try:
            w3.middleware_onion.inject(POA, layer=0)
        except Exception:
            pass

    # web3.py v7: is_connected() 调用 web3_clientVersion, Alchemy 不支持
    # 改用 eth_blockNumber 实际测试
    try:
        blk = w3.eth.block_number
        print(f"   ✅ RPC 连接正常, 当前区块 {blk}")
    except Exception as e:
        print(f"❌ 无法连接 RPC: {e}")
        sys.exit(1)
    return w3


# ── 获取回合信息 ──────────────────────────────────────────────────────────────
def get_current_round_ts() -> int:
    now = int(time.time())
    return now - (now % ROUND_DURATION)




def _make_hourly_slug(round_ts: int) -> str:
    """生成 1h 市场的 slug, 如 bitcoin-up-or-down-may-16-2026-5am-et"""
    from datetime import timedelta
    et_dt = datetime.fromtimestamp(round_ts, tz=timezone.utc) - timedelta(hours=4)
    month = et_dt.strftime("%B").lower()
    day = et_dt.day
    year = et_dt.year
    hour = et_dt.hour
    ampm = "am" if hour < 12 else "pm"
    h12 = hour % 12
    if h12 == 0:
        h12 = 12
    return f"bitcoin-up-or-down-{month}-{day}-{year}-{h12}{ampm}-et"


def get_round_token_ids(round_ts: int, prefix: str = "5m") -> Optional[dict]:
    """获取回合的 UP/DOWN token_id (含重试)
    prefix: "5m", "15m", "1h"
    """
    if prefix == "1h":
        slug = _make_hourly_slug(round_ts)
    else:
        slug = f"btc-updown-{prefix}-{round_ts}"
    for attempt in range(3):
        try:
            r = requests.get(
                "https://gamma-api.polymarket.com/events",
                params={"slug": slug},
                timeout=20,
            )
            events = r.json()
            if not events or not isinstance(events, list):
                return None

            markets = events[0].get("markets", [])
            if not markets:
                return None

            mkt = markets[0]
            tokens = mkt.get("clobTokenIds", "[]")
            if isinstance(tokens, str):
                tokens = json.loads(tokens)

            outcomes = mkt.get("outcomes", "[]")
            if isinstance(outcomes, str):
                outcomes = json.loads(outcomes)

            result = {}
            for i, outcome in enumerate(outcomes):
                if i < len(tokens):
                    key = outcome.lower()
                    result[key] = tokens[i]

            return result if result else None
        except Exception as e:
            if attempt < 2:
                print(f"   ⚠️ Gamma API 第{attempt+1}次失败: {e}, 重试...")
                time.sleep(3)
            else:
                print(f"❌ 获取回合信息失败 (3次重试): {e}")
                return None


def ts_to_block(w3, ts: int) -> int:
    """粗略估算时间戳对应的区块号 (Polygon ~2s/块)"""
    current_block = w3.eth.block_number
    current_ts = int(time.time())
    blocks_ago = (current_ts - ts) // 2
    estimated = current_block - blocks_ago
    return max(estimated - 10, 0)  # 多往前 10 块确保不漏


def _scan_resync_floor(w3, tip_block: int, scan_state: dict, lookback_sec: int) -> int:
    """计算重同步起始区块：覆盖 5m/15m/1h 当前回合，且不超过 tip 回看窗口。"""
    now_ts = int(time.time())
    round_floor = ts_to_block(w3, scan_state["current_round_ts"] - lookback_sec)
    for duration in (900, 3600):
        tf_round = now_ts - (now_ts % duration)
        round_floor = min(round_floor, ts_to_block(w3, tf_round - lookback_sec))
    lookback_blocks = max(150, int(lookback_sec))
    tip_floor = max(0, tip_block - lookback_blocks)
    return max(0, min(round_floor, tip_floor) - 1)


# ── 链上事件扫描 ──────────────────────────────────────────────────────────────
def scan_transfers(w3, from_block: int, to_block: int, quiet: bool = False) -> list:
    """扫描 CTF 合约的 TransferSingle 事件 (并发 RPC)"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    total_blocks = to_block - from_block + 1
    if total_blocks <= 0:
        return []

    BATCH = 5
    WORKERS = 3
    ctf_cs = w3.to_checksum_address(CTF_ADDR)

    # 构建批次列表
    batches = []
    for start in range(from_block, to_block + 1, BATCH):
        end = min(start + BATCH - 1, to_block)
        batches.append((start, end))

    all_logs = [None] * len(batches)  # 保持顺序
    done_count = [0]

    def _fetch_batch(idx, start, end):
        try:
            logs = w3.eth.get_logs({
                "address": ctf_cs,
                "topics": [TRANSFER_SINGLE_TOPIC],
                "fromBlock": start,
                "toBlock": end,
            })
            return idx, logs
        except Exception as e:
            # 逐块重试
            result = []
            err_count = 0
            for b in range(start, end + 1):
                try:
                    logs = w3.eth.get_logs({
                        "address": ctf_cs,
                        "topics": [TRANSFER_SINGLE_TOPIC],
                        "fromBlock": b,
                        "toBlock": b,
                    })
                    result.extend(logs)
                except Exception:
                    err_count += 1
            if err_count > 0 and not quiet:
                print(f"\n   ⚠️ 批次 {start}-{end} 重试, {err_count}/{end-start+1} 块失败", flush=True)
            return idx, result

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_fetch_batch, i, s, e): i for i, (s, e) in enumerate(batches)}
        for future in as_completed(futures):
            idx, logs = future.result()
            all_logs[idx] = logs
            done_count[0] += 1
            if not quiet and total_blocks > 30:
                done_blocks = min(done_count[0] * BATCH, total_blocks)
                total_logs = sum(len(l) for l in all_logs if l)
                print(f"\r   扫描进度: {done_blocks}/{total_blocks} 块, {total_logs} 条事件", end="", flush=True)

    if not quiet and total_blocks > 30:
        print()  # 换行

    # 展平 (保持区块顺序)
    result = []
    for batch_logs in all_logs:
        if batch_logs:
            result.extend(batch_logs)
    return result


def build_balances(logs: list, target_token_ids: set, w3):
    """
    从 TransferSingle 事件构建余额表
    返回: (balances, block_map)
        balances:  {token_id: {address: shares}}
        block_map: {token_id: {address: [block_numbers...]}}
    """
    balances = defaultdict(lambda: defaultdict(float))
    block_map = defaultdict(lambda: defaultdict(list))
    _cs_cache = {}  # checksum 缓存

    def _checksum(hex40: str) -> str:
        if hex40 not in _cs_cache:
            _cs_cache[hex40] = w3.to_checksum_address("0x" + hex40)
        return _cs_cache[hex40]

    for log_entry in logs:
        data = log_entry["data"]
        if isinstance(data, str):
            data = bytes.fromhex(data[2:])
        elif hasattr(data, "hex"):
            data = bytes(data)

        token_id = str(int.from_bytes(data[:32], "big"))
        if token_id not in target_token_ids:
            continue

        shares = int.from_bytes(data[32:64], "big") / 1e6
        block_num = log_entry["blockNumber"]

        topics = log_entry["topics"]
        from_hex = topics[2].hex()[-40:] if hasattr(topics[2], "hex") else topics[2][-40:]
        to_hex = topics[3].hex()[-40:] if hasattr(topics[3], "hex") else topics[3][-40:]
        from_addr = _checksum(from_hex)
        to_addr = _checksum(to_hex)

        if from_addr != ZERO_ADDR:
            balances[token_id][from_addr] -= shares

        if to_addr != ZERO_ADDR:
            balances[token_id][to_addr] += shares
            block_map[token_id][to_addr].append(block_num)

    return balances, block_map


# ── 显示排行 ──────────────────────────────────────────────────────────────────
import unicodedata

# 4连胜名单 (手动维护, 热重载)
_STREAK_LIST_FILE = os.path.join(os.path.dirname(__file__), "持仓", "4轮连胜down.txt")
_streak_list = set()
_hot_streak_map = {}  # {checksum_addr: consecutive_win_count}


def reload_streak_list():
    """从 持仓/4轮连胜down.txt 重载手动连胜名单"""
    global _streak_list
    addrs = set()
    try:
        with open(_STREAK_LIST_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("0x") and len(line) >= 42:
                    try:
                        addrs.add(Web3.to_checksum_address(line[:42]))
                    except Exception:
                        addrs.add(line[:42])
    except FileNotFoundError:
        pass
    _streak_list = addrs


reload_streak_list()

def _display_width(s: str) -> int:
    """计算字符串在终端中的实际显示宽度 (emoji/中文占2格)"""
    w = 0
    for ch in s:
        if unicodedata.east_asian_width(ch) in ('W', 'F'):
            w += 2
        elif ord(ch) >= 0x1F000:
            w += 2
        else:
            w += 1
    return w


def _pad(s: str, width: int) -> str:
    """按终端显示宽度填充空格对齐"""
    return s + " " * max(0, width - _display_width(s))


# ANSI 颜色
_GREEN = "\033[32m"
_RED = "\033[31m"
_RESET = "\033[0m"

def format_entry(rank: int, addr: str, shares: float, pct: float, hedged: bool = False, streak_count: int = 0) -> str:
    """格式化单条排名 (含用户名 + PnL 颜色, 仅鲸鱼)"""
    is_whale = addr in TRACKED_WHALES_CS
    whale_tag = "🐋" if is_whale else "  "
    hedge_tag = "⚖️" if hedged else "  "
    streak_tag = f"🔥{streak_count}" if streak_count >= STREAK_MIN_ROUNDS else ""

    extra = ""
    if is_whale:
        info = get_user_info(addr)
        name = info.get("name", "")
        pnl = info.get("pnl")

        # 用户名
        name_str = f"({name})" if name else ""
        if len(name_str) > 28:
            name_str = f"({name[:25]}..)"

        # PnL 带颜色
        pnl_str = ""
        if pnl is not None:
            pnl_val = f"${pnl:+,.0f}"
            if pnl > 1000:
                pnl_str = f"{_GREEN}{pnl_val}{_RESET}"
            elif pnl < 0:
                pnl_str = f"{_RED}{pnl_val}{_RESET}"
            else:
                pnl_str = pnl_val

        extra_parts = " ".join(filter(None, [name_str, pnl_str]))
        if extra_parts:
            extra = " " + extra_parts

    tag = f"{whale_tag}{hedge_tag}"
    line = f"{rank:>2}. {addr} {shares:>8,.0f}股 ({pct:>5.1f}%) {tag}{extra}{streak_tag}"
    if streak_count >= STREAK_MIN_ROUNDS:
        line = f"{_RED}{line}{_RESET}"
    return line


def net_positions(balances: dict, token_ids: dict):
    """
    对两边都持仓的地址处理:
    - FILTER_MARKET_MAKERS=true: 完全过滤, 不进入排行榜
    - FILTER_MARKET_MAKERS=false: 净额合并 (8000 UP + 6000 DOWN → 2000 UP, 标记 ⚖️)
    返回: (up_list, down_list, hedged_addrs)
        up_list/down_list: [(addr, net_shares), ...]
        hedged_addrs: set of addresses that had positions on both sides
    """
    up_tid = token_ids.get("up")
    dn_tid = token_ids.get("down")

    up_raw = {a: s for a, s in list(balances.get(up_tid, {}).items()) if s > 0.5} if up_tid else {}
    dn_raw = {a: s for a, s in list(balances.get(dn_tid, {}).items()) if s > 0.5} if dn_tid else {}

    both = set(up_raw.keys()) & set(dn_raw.keys())
    hedged_addrs = set(both)

    up_net = {}
    dn_net = {}

    if FILTER_MARKET_MAKERS:
        for addr, shares in up_raw.items():
            if addr not in both:
                up_net[addr] = shares
        for addr, shares in dn_raw.items():
            if addr not in both:
                dn_net[addr] = shares
    else:
        for addr, shares in up_raw.items():
            if addr not in both:
                up_net[addr] = shares
        for addr, shares in dn_raw.items():
            if addr not in both:
                dn_net[addr] = shares

        for addr in both:
            u = up_raw[addr]
            d = dn_raw[addr]
            net = u - d
            if net > 0.5:
                up_net[addr] = net
            elif net < -0.5:
                dn_net[addr] = abs(net)

    up_list = sorted(up_net.items(), key=lambda x: -x[1])
    dn_list = sorted(dn_net.items(), key=lambda x: -x[1])

    return up_list, dn_list, hedged_addrs


def _maker_filter_msg(hedged_addrs: set) -> str | None:
    if not hedged_addrs:
        return None
    if FILTER_MARKET_MAKERS:
        return f"  🚫 已过滤 {len(hedged_addrs)} 个做市商 (双向持仓)"
    return f"  ⚖️ = 两边持仓已净额合并 ({len(hedged_addrs)} 个做市商)"


# ── BTC 价格获取 ─────────────────────────────────────────────────────────────
_price_session = None
_cached_strike = {"round_ts": 0, "price": 0.0}

def _get_price_session():
    global _price_session
    if _price_session is None:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        _price_session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(max_retries=2)
        _price_session.mount("https://", adapter)
    return _price_session

def _robust_get_json(session, url, timeout=5, headers=None) -> dict:
    """
    发送 GET 请求并解析为 JSON。
    首先尝试使用 session.get，若失败或遭遇非 200 状态码，
    则自动 fallback 使用系统 curl 命令抓取以绕过 Cloudflare WAF 拦截。
    """
    try:
        r = session.get(url, timeout=timeout, verify=False, headers=headers)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass

    # Fallback: 使用系统 curl
    import subprocess, json
    try:
        headers_list = []
        if headers:
            for k, v in headers.items():
                headers_list.extend(["-H", f"{k}: {v}"])
        cmd = ["curl", "-s"] + headers_list + [url]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if res.returncode == 0:
            return json.loads(res.stdout.strip())
    except Exception:
        pass
    return None


def get_strike_price(round_ts: int) -> float:
    """获取本回合的锚定价 (strike)。incomplete 时持续用 REST 轮询覆盖，避免首笔临时价锁死。"""
    global _cached_strike
    try:
        open_px, close_px, incomplete = fetch_window_open_price(round_ts)
        if open_px > 0:
            # 已完成或已确认的开盘价可缓存；未完成时仍写入但不阻止下次刷新
            if not incomplete or _cached_strike["round_ts"] != round_ts or _cached_strike["price"] <= 0:
                _cached_strike = {"round_ts": round_ts, "price": open_px}
            else:
                _cached_strike = {"round_ts": round_ts, "price": open_px}
            return open_px
    except Exception:
        pass
    if _cached_strike["round_ts"] == round_ts:
        return _cached_strike["price"]
    return 0.0

_btc_prices = {"strike": 0.0, "current": 0.0, "round_ts": 0,
               "up_price": 0.0, "down_price": 0.0, "token_ids": {},
               "strike_15m": 0.0, "strike_1h": 0.0,
               "current_15m": 0.0, "current_1h": 0.0,
               "_last_15m_ts": 0, "_last_1h_ts": 0}
_btc_price_lock = threading.Lock()

CRYPTO_TF_DURATION = {
    "5m": 300,
    "15m": 900,
    "1h": 3600,
}


def fetch_polymarket_crypto_price(start_ts: int, duration: int, symbol: str = "BTC",
                                  variant: str = "fiveminute"):
    """按 Polymarket 官网同款参数拉取开盘价/收盘价。
    GET /api/crypto/crypto-price?symbol=&eventStartTime=&variant=fiveminute&endDate=

    注意：15m/1h 也必须用 variant=fiveminute，并对「窗口起点起的 5 分钟切片」取 openPrice。
    fifteenminute/onehour 返回的是整点开盘价，不是该回合真实开盘价。
    返回 (openPrice, closePrice, incomplete)
    """
    try:
        start_iso = datetime.fromtimestamp(int(start_ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        end_iso = datetime.fromtimestamp(int(start_ts) + int(duration), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        url = (
            f"https://polymarket.com/api/crypto/crypto-price?symbol={symbol}"
            f"&eventStartTime={start_iso}&variant={variant}&endDate={end_iso}"
            f"&_={int(time.time() * 1000)}"
        )
        s = _get_price_session()
        data = _robust_get_json(s, url, timeout=5, headers={
            "User-Agent": "Mozilla/5.0",
            "Cache-Control": "no-cache",
        })
        if not data:
            return 0.0, 0.0, True
        open_px = float(data.get("openPrice") or 0)
        close_raw = data.get("closePrice")
        close_px = float(close_raw) if close_raw is not None else 0.0
        incomplete = bool(data.get("incomplete", False)) and not bool(data.get("completed", False))
        return open_px, close_px, incomplete
    except Exception:
        return 0.0, 0.0, True


def fetch_window_open_price(window_start_ts: int, symbol: str = "BTC"):
    """任意周期窗口的真实开盘价 = 该窗口起点对应 5m 切片的 openPrice。"""
    return fetch_polymarket_crypto_price(int(window_start_ts), 300, symbol, "fiveminute")


def _sync_prices_to_quick_trade(strike=None, current=None, strike_15m=None, current_15m=None,
                                strike_1h=None, current_1h=None):
    try:
        import quick_trade
        with quick_trade.state_lock:
            if strike is not None and float(strike) > 0:
                quick_trade.state["strike"] = float(strike)
            if current is not None and float(current) > 0:
                quick_trade.state["crypto_current"] = float(current)
            if strike_15m is not None and float(strike_15m) > 0:
                quick_trade.state["strike_15m"] = float(strike_15m)
            if current_15m is not None and float(current_15m) > 0:
                quick_trade.state["crypto_current_15m"] = float(current_15m)
            if strike_1h is not None and float(strike_1h) > 0:
                quick_trade.state["strike_1h"] = float(strike_1h)
            if current_1h is not None and float(current_1h) > 0:
                quick_trade.state["crypto_current_1h"] = float(current_1h)
    except Exception:
        pass


def _btc_crypto_price_rest_worker():
    """独立 REST 轮询官网 crypto-price：
    - 各周期开盘价：统一 variant=fiveminute，取窗口起点的 5m openPrice
    - 现价：5m 若有 closePrice 则写入；否则保留 RTDS Chainlink
    - 15m/1h 现价与 5m 现价相同（同一现货），不使用 fifteenminute/onehour 的 close
    """
    while True:
        try:
            now = int(time.time())
            with _btc_price_lock:
                rts = int(_btc_prices.get("round_ts") or 0)
                spot = float(_btc_prices.get("current") or 0)
            ts5 = rts if rts > 0 else (now - (now % 300))
            if ts5 > 0 and now - ts5 >= 300:
                ts5 = now - (now % 300)

            windows = {
                "5m": ts5,
                "15m": now - (now % 900),
                "1h": now - (now % 3600),
            }

            # 去重：同一 start_ts 只请求一次
            open_by_ts = {}
            for tf, start_ts in windows.items():
                if start_ts in open_by_ts:
                    continue
                open_px, _close_px, _incomplete = fetch_window_open_price(start_ts)
                open_by_ts[start_ts] = open_px
                time.sleep(0.35)

            open_5m = float(open_by_ts.get(windows["5m"]) or 0)
            open_15m = float(open_by_ts.get(windows["15m"]) or 0)
            open_1h = float(open_by_ts.get(windows["1h"]) or 0)
            # 现价以 RTDS Chainlink 现货为准（官网「当前价格」）；TWAP60 另存不覆盖
            # 不用 crypto-price 的 closePrice（进行中常为 null），也不用 Binance btcusdt

            with _btc_price_lock:
                if open_5m > 0:
                    _btc_prices["strike"] = open_5m
                    _btc_prices["_last_5m_ts"] = windows["5m"]
                if open_15m > 0:
                    _btc_prices["strike_15m"] = open_15m
                    _btc_prices["_last_15m_ts"] = windows["15m"]
                if open_1h > 0:
                    _btc_prices["strike_1h"] = open_1h
                    _btc_prices["_last_1h_ts"] = windows["1h"]
                strike = float(_btc_prices.get("strike") or 0)
                current = float(_btc_prices.get("current") or 0)
                s15 = float(_btc_prices.get("strike_15m") or 0)
                s1h = float(_btc_prices.get("strike_1h") or 0)
                spot = current

            _sync_prices_to_quick_trade(
                strike=strike or None,
                current=current or None,
                strike_15m=s15 or None,
                current_15m=spot or None,
                strike_1h=s1h or None,
                current_1h=spot or None,
            )
        except Exception:
            pass
        time.sleep(3)

def _btc_price_ws_worker():
    """后台线程: 通过 Polymarket RTDS WebSocket 接收实时 BTC 价格
    - 当前价: Chainlink Data Streams via WebSocket (每秒更新)
    - 锚定价: Polymarket crypto-price REST API (每回合一次)
    """
    import asyncio, json as _json

    def _detect_proxy():
        """自动检测代理设置"""
        import socket
        # 1. 检查环境变量
        for key in ("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY",
                     "http_proxy", "HTTP_PROXY"):
            val = os.environ.get(key, "").strip()
            if val:
                return val
        # 2. 探测常见本地代理端口
        for port in (9098, 9099, 7890, 7897, 1080, 8080):
            try:
                s = socket.create_connection(("127.0.0.1", port), timeout=0.3)
                s.close()
                return f"http://127.0.0.1:{port}"
            except (OSError, socket.timeout):
                continue
        return None


    ws_kwargs = dict(ping_interval=20, ping_timeout=10, close_timeout=5)

    async def _run_rtds():
        import websockets
        s = _get_price_session()
        from datetime import timezone as tz
        last_strike_round = 0

        while True:
            try:
                async with websockets.connect(
                    "wss://ws-live-data.polymarket.com", **ws_kwargs,
                ) as ws:
                    # 官网 5m：
                    # - 目标价 = crypto-price openPrice（回合开盘快照）
                    # - 当前价 = Chainlink 现货（UI「当前价格」）；TWAP60 仅结算用，另存缓存
                    sub = {"action": "subscribe", "subscriptions": [
                        {"topic": "crypto_prices_chainlink", "type": "*"},
                        {"topic": "crypto_prices_twap_sixty", "type": "*"},
                        {"topic": "crypto_prices_twap_thirty", "type": "*"},
                        {"topic": "crypto_prices", "type": "*"},
                    ]}
                    await ws.send(_json.dumps(sub))

                    async for raw in ws:
                        if not raw or not raw.strip():
                            continue
                        try:
                            data = _json.loads(raw)
                        except ValueError:
                            continue

                        # 解析价格推送
                        payload = data.get("payload", {})
                        topic = str(data.get("topic") or "")
                        if isinstance(payload, dict) and payload.get("value"):
                            price = float(payload["value"])
                            symbol = str(payload.get("symbol", "")).lower()
                            if price > 0:
                                is_btc = symbol in ("btcusdt", "btc/usd", "btc-usd")
                                if topic == "crypto_prices_chainlink" and symbol == "btc/usd":
                                    # 官网「当前价格」用 Chainlink 现货
                                    with _btc_price_lock:
                                        _btc_prices["current"] = price
                                        _btc_prices["current_15m"] = price
                                        _btc_prices["current_1h"] = price
                                    _sync_prices_to_quick_trade(
                                        current=price,
                                        current_15m=price,
                                        current_1h=price,
                                    )
                                    try:
                                        import quick_trade
                                        quick_trade._rtds_prices["btc/usd_chainlink"] = price
                                    except Exception:
                                        pass
                                elif topic == "crypto_prices_twap_sixty" and is_btc:
                                    try:
                                        import quick_trade
                                        quick_trade._rtds_prices["btc/usd_twap60"] = price
                                    except Exception:
                                        pass
                                elif topic == "crypto_prices_twap_thirty" and is_btc:
                                    try:
                                        import quick_trade
                                        quick_trade._rtds_prices["btc/usd_twap30"] = price
                                    except Exception:
                                        pass
                                elif topic == "crypto_prices" and is_btc:
                                    # Binance 流仅作对照，不覆盖官网现价
                                    try:
                                        import quick_trade
                                        quick_trade._rtds_prices["btcusdt"] = price
                                        quick_trade._rtds_prices["btc/usd"] = price
                                    except Exception:
                                        pass
                                elif symbol in ("eth/usd", "ethusdt"):
                                    try:
                                        import quick_trade
                                        quick_trade._rtds_prices["eth/usd"] = price
                                        if symbol == "ethusdt":
                                            quick_trade._rtds_prices["ethusdt"] = price
                                    except Exception:
                                        pass

                        # 检查是否需要更新锚定价 (每回合一次，后续由 REST 轮询持续校正)
                        with _btc_price_lock:
                            round_ts = _btc_prices["round_ts"]
                        if round_ts > 0 and last_strike_round != round_ts:
                            try:
                                strike, close_px, _ = fetch_window_open_price(round_ts)
                                if strike > 0:
                                    with _btc_price_lock:
                                        _btc_prices["strike"] = strike
                                        # 进行中的 5m closePrice 常为 null；有值时也不覆盖官网现价流
                                    last_strike_round = round_ts
                                    _sync_prices_to_quick_trade(strike=strike)
                            except Exception:
                                pass

                        # 15分钟 / 1小时 strike (每10秒检查一次)
                        if time.time() - getattr(_run_rtds, '_last_multi_check', 0) > 10:
                            _run_rtds._last_multi_check = time.time()
                            try:
                                now_utc = datetime.now(tz=tz.utc)
                                # 15m 对齐
                                m15 = now_utc.minute // 15 * 15
                                ts_15m = int(now_utc.replace(minute=m15, second=0, microsecond=0).timestamp())
                                # 1h 对齐
                                ts_1h = int(now_utc.replace(minute=0, second=0, microsecond=0).timestamp())
                                with _btc_price_lock:
                                    last_15m = _btc_prices["_last_15m_ts"]
                                    last_1h = _btc_prices["_last_1h_ts"]
                                if ts_15m != last_15m:
                                    open15, _, _ = fetch_window_open_price(ts_15m)
                                    if open15 > 0:
                                        with _btc_price_lock:
                                            _btc_prices["strike_15m"] = open15
                                            _btc_prices["_last_15m_ts"] = ts_15m
                                if ts_1h != last_1h:
                                    open1h, _, _ = fetch_window_open_price(ts_1h)
                                    if open1h > 0:
                                        with _btc_price_lock:
                                            _btc_prices["strike_1h"] = open1h
                                            _btc_prices["_last_1h_ts"] = ts_1h
                            except Exception:
                                pass

            except Exception:
                pass
            # 断线重连
            await asyncio.sleep(2)

    async def _run_clob():
        """CLOB Market WS: 订阅 UP/DOWN 价格变动"""
        import websockets
        while True:
            try:
                with _btc_price_lock:
                    tids = _btc_prices["token_ids"]
                asset_ids = [v for v in tids.values() if v]
                if not asset_ids:
                    await asyncio.sleep(2)
                    continue

                subscribed_tids = set(asset_ids)

                async with websockets.connect(
                    "wss://ws-subscriptions-clob.polymarket.com/ws/market",
                    **ws_kwargs,
                ) as ws:
                    sub = {"assets_ids": asset_ids, "type": "market"}
                    await ws.send(_json.dumps(sub))

                    async for raw in ws:
                        if not raw or not raw.strip():
                            continue
                        try:
                            data = _json.loads(raw)
                        except ValueError:
                            continue

                        # 统一处理: list(初始快照) 或 dict(后续事件)
                        events = data if isinstance(data, list) else [data]
                        with _btc_price_lock:
                            cur_tids = _btc_prices["token_ids"]

                        for item in events:
                            if not isinstance(item, dict):
                                continue
                            evt = item.get("event_type", "")
                            aid = item.get("asset_id", "")

                            if evt == "book":
                                # 初始快照: 取 best bid 作为初始价
                                bids = item.get("bids", [])
                                if bids:
                                    best = max(bids, key=lambda b: float(b.get("price", 0)))
                                    price = float(best.get("price", 0))
                                    if price > 0:
                                        if aid == cur_tids.get("up"):
                                            with _btc_price_lock:
                                                _btc_prices["up_price"] = price
                                        elif aid == cur_tids.get("down"):
                                            with _btc_price_lock:
                                                _btc_prices["down_price"] = price

                            elif evt == "price_change":
                                for pc in item.get("price_changes", []):
                                    pc_aid = pc.get("asset_id", "")
                                    # 用 best_bid (盘口最优买价) 而非 price (挂单价)
                                    best_bid = float(pc.get("best_bid", 0))
                                    if best_bid > 0:
                                        if pc_aid == cur_tids.get("up"):
                                            with _btc_price_lock:
                                                _btc_prices["up_price"] = best_bid
                                        elif pc_aid == cur_tids.get("down"):
                                            with _btc_price_lock:
                                                _btc_prices["down_price"] = best_bid

                        # 检查 token 是否变了 (新回合) → 断开重连新 token
                        with _btc_price_lock:
                            new_tids = set(_btc_prices["token_ids"].values())
                        if new_tids != subscribed_tids:
                            break  # 退出重连

            except Exception:
                pass
            await asyncio.sleep(2)

    async def _poll_clob_prices():
        """REST 轮询 UP/DOWN 最优价 (兜底, 防 WS 不推送)"""
        import aiohttp
        while True:
            try:
                with _btc_price_lock:
                    tids = dict(_btc_prices["token_ids"])
                if not tids:
                    await asyncio.sleep(3)
                    continue

                async with aiohttp.ClientSession() as session:
                    for side, tid in tids.items():
                        if not tid:
                            continue
                        try:
                            url = f"https://clob.polymarket.com/book?token_id={tid}"
                            async with session.get(url, timeout=aiohttp.ClientTimeout(total=5), ssl=False) as resp:
                                if resp.status == 200:
                                    book = await resp.json(content_type=None)
                                    bids = book.get("bids", [])
                                    if bids:
                                        best = max(bids, key=lambda b: float(b.get("price", 0)))
                                        price = float(best.get("price", 0))
                                        if price > 0:
                                            key = f"{side}_price"
                                            with _btc_price_lock:
                                                _btc_prices[key] = price
                        except Exception:
                            pass
            except Exception:
                pass
            await asyncio.sleep(3)

    async def _run_all():
        await asyncio.gather(_run_rtds(), _run_clob(), _poll_clob_prices())

    asyncio.run(_run_all())

def start_btc_price_feed():
    """启动 BTC 实时价格 WebSocket + crypto-price REST 轮询"""
    threading.Thread(target=_btc_price_ws_worker, daemon=True).start()
    threading.Thread(target=_btc_crypto_price_rest_worker, daemon=True).start()

def set_price_round(round_ts: int, token_ids: dict = None):
    """设置当前回合时间和 token_ids (供价格线程使用)"""
    with _btc_price_lock:
        if _btc_prices["round_ts"] != round_ts:
            _btc_prices["round_ts"] = round_ts
            _btc_prices["current"] = 0.0
            _btc_prices["up_price"] = 0.0
            _btc_prices["down_price"] = 0.0
        if token_ids:
            _btc_prices["token_ids"] = dict(token_ids)

def get_btc_prices() -> tuple:
    """返回 (锚定价, 当前价)"""
    with _btc_price_lock:
        return _btc_prices["strike"], _btc_prices["current"]

_PRICE_LINE_NUM = 3  # 价格行在终端中的行号 (清屏后)
_PRICE_LINE_W = 163  # 行宽度

def _format_price_line() -> str:
    """生成价格行文本"""
    strike, btc_price = get_btc_prices()
    with _btc_price_lock:
        up_p = _btc_prices["up_price"]
        dn_p = _btc_prices["down_price"]
        s15 = _btc_prices["strike_15m"]
        s1h = _btc_prices["strike_1h"]
    if strike <= 0 and btc_price <= 0:
        return ""
    parts = []
    # 现价
    if btc_price > 0:
        parts.append(f"💰 现价: ${btc_price:,.2f}")
    # 三个锚定价 + 各自差值
    def _strike_part(label, s):
        if s <= 0:
            return None
        if btc_price > 0:
            d = btc_price - s
            arrow = "🟢" if d > 0 else "🔴" if d < 0 else "⚪"
            return f"📌{label}: ${s:,.2f} ({arrow}{d:+,.2f})"
        return f"📌{label}: ${s:,.2f}"
    for label, sv in [("5m", strike), ("15m", s15), ("1h", s1h)]:
        p = _strike_part(label, sv)
        if p:
            parts.append(p)
    # UP/DN 价格
    if up_p > 0 or dn_p > 0:
        up_c = int(up_p * 100) if up_p > 0 else "--"
        dn_c = int(dn_p * 100) if dn_p > 0 else "--"
        parts.append(f"UP {up_c}¢ / DN {dn_c}¢")
    return f"  {'  |  '.join(parts)}"

def _update_price_line():
    """用 ANSI 转义原地刷新价格行 (不重绘整个屏幕)"""
    line = _format_price_line()
    if not line:
        return
    # \033[s = 保存光标  \033[{row};1H = 移动到第 row 行第 1 列  \033[2K = 清除整行  \033[u = 恢复光标
    import sys
    sys.stdout.write(f"\033[s\033[{_PRICE_LINE_NUM};1H\033[2K{line}\033[u")
    sys.stdout.flush()


def display_leaderboard(
    balances: dict, token_ids: dict, round_ts: int, round_end: int, scan_block: int,
):
    """终端显示排行榜 — UP/DOWN 左右并排, 净额显示"""
    now = int(time.time())
    remaining = max(0, round_end - now)
    round_time = datetime.fromtimestamp(round_ts).strftime("%H:%M:%S")

    # 净额计算
    up_ranked, dn_ranked, hedged_addrs = net_positions(balances, token_ids)
    up_total = sum(s for _, s in up_ranked)
    dn_total = sum(s for _, s in dn_ranked)

    # 列宽 — 分割线固定在第 COL+1 列
    COL = 80
    DIV_COL = COL + 1  # │ 的绝对列位置
    DIV = " │ "
    W = COL * 2 + len(DIV)

    # ANSI 光标定位: 移动到第 N 列
    def goto(col):
        return f"\033[{col}G"

    def print_row(left, right):
        """打印一行: left 内容 + 光标跳到固定列 + │ + right 内容"""
        print(f"{left}{goto(DIV_COL)}{DIV}{right}")

    # 清屏 + 清滚动缓冲区 (ANSI, 无需 fork 子进程)
    sys.stdout.write("\033[2J\033[3J\033[H")
    sys.stdout.flush()

    print("═" * W)
    header = f"  🏆 BTC 5m 链上持仓排行榜  |  回合 {round_time}  |  剩余 {remaining}s  |  区块 {scan_block}  |  📡 链上 maker+taker"
    print(header)
    # BTC 价格行 (Polymarket RTDS WebSocket)
    price_line = _format_price_line()
    if price_line:
        print(price_line)
    else:
        print("  ⏳ 等待价格数据...")
    if hedged_addrs:
        msg = _maker_filter_msg(hedged_addrs)
        if msg:
            print(msg)
    # 上轮赢家在本轮的方向统计
    follow_stats = compute_winner_follow_stats(up_ranked, dn_ranked, balances, token_ids)
    if follow_stats:
        side_label = follow_stats["prev_side"].upper() if follow_stats["prev_side"] else "?"
        net_dir = follow_stats["net_dir"]
        arrow = "🟢" if net_dir == "UP" else "🔴" if net_dir == "DN" else "⚪"
        print(
            f"  🏅 上轮{side_label}赢家 {follow_stats['prev_total']}人 | "
            f"本轮: {follow_stats['up_n']}人UP({follow_stats['up_s']:,.0f}股) vs "
            f"{follow_stats['dn_n']}人DN({follow_stats['dn_s']:,.0f}股) | "
            f"{arrow} 净{net_dir} {follow_stats['net_shares']:,.0f}股"
        )
    # 4连胜名单方向统计
    if _streak_list:
        up_addrs_sl = {a for a, _ in up_ranked}
        dn_addrs_sl = {a for a, _ in dn_ranked}
        sl_up = len(_streak_list & up_addrs_sl)
        sl_dn = len(_streak_list & dn_addrs_sl)
        sl_arrow = "🟢" if sl_up > sl_dn else "🔴" if sl_dn > sl_up else "⚪"
        print(f"  📊 4连胜名单 {len(_streak_list)}人 | 本轮: {sl_up}人UP vs {sl_dn}人DN | {sl_arrow}")
    hot_stats = _hot_streak_stats(up_ranked, dn_ranked)
    hot_items = hot_stats["items"]
    if hot_items:
        ratio = _format_hot_streak_ratio(hot_stats)
        parts = []
        for h in hot_items[:10]:
            short = h["addr"][:6] + ".." + h["addr"][-4:]
            parts.append(f"{short} 🔥{h['count']} {h['side']} {h['shares']:,.0f}股")
        print(f"  🔥 连胜冒火 (本轮 {hot_stats['total']}人): {ratio}")
        print(f"     " + " | ".join(parts))
    print("═" * W)

    if follow_stats:
        winner_invest = _round_invest_stats(follow_stats["up_n"], follow_stats["dn_n"], 0, 0)
        invest_line = _format_round_invest(winner_invest)
        if invest_line:
            side_label = follow_stats["prev_side"].upper() if follow_stats.get("prev_side") else "?"
            print(f"  📊 本轮投入(上轮{side_label}赢家): {invest_line}")

    # 列标题 (含连胜人数)
    up_addrs = {a for a, _ in up_ranked}
    dn_addrs = {a for a, _ in dn_ranked}
    streak_up = sum(1 for a in up_addrs if get_streak_count(a) >= STREAK_MIN_ROUNDS)
    streak_dn = sum(1 for a in dn_addrs if get_streak_count(a) >= STREAK_MIN_ROUNDS)
    up_streak_str = f"  🔥{streak_up}" if streak_up else ""
    dn_streak_str = f"  🔥{streak_dn}" if streak_dn else ""
    up_hdr = f"  🟢 UP (涨)  {len(up_ranked)}人  净总计 {up_total:,.0f}股{up_streak_str}"
    dn_hdr = f"  🔴 DOWN (跌)  {len(dn_ranked)}人  净总计 {dn_total:,.0f}股{dn_streak_str}"
    print_row(up_hdr, dn_hdr)
    print(f"{'─' * COL}{DIV}{'─' * COL}")

    # 逐行输出 (同排名对齐)
    max_rows = max(len(up_ranked[:100]), len(dn_ranked[:100]))
    for i in range(max_rows):
        # 左列 (UP)
        if i < len(up_ranked) and i < 100:
            addr, shares = up_ranked[i]
            pct = shares / up_total * 100 if up_total > 0 else 0
            left = format_entry(i + 1, addr, shares, pct, addr in hedged_addrs, get_streak_count(addr))
        else:
            left = ""

        # 右列 (DOWN)
        if i < len(dn_ranked) and i < 100:
            addr, shares = dn_ranked[i]
            pct = shares / dn_total * 100 if dn_total > 0 else 0
            right = format_entry(i + 1, addr, shares, pct, addr in hedged_addrs, get_streak_count(addr))
        else:
            right = ""

        print_row(left, right)

    print(f"{'─' * COL}{DIV}{'─' * COL}")
    print(f"  🔄 {datetime.now().strftime('%H:%M:%S')} 更新  |  Ctrl+C 退出")
    print()

    # ── 推送到 Web 前端 ──
    try:
        import quick_trade
        def _entry(addr, shares, hedged):
            sc = get_streak_count(addr)
            info = get_user_info(addr)
            return {
                "addr": addr,
                "shares": round(shares, 1),
                "whale": addr in TRACKED_WHALES_CS,
                "hedged": hedged,
                "streak": sc >= STREAK_MIN_ROUNDS,
                "streak_count": sc,
                "name": info.get("name", ""),
                "pnl": info.get("pnl"),
            }
        hot_stats = _hot_streak_stats(up_ranked, dn_ranked)
        hot_streaks = []
        for h in hot_stats["items"]:
            info = get_user_info(h["addr"])
            hot_streaks.append({
                **h,
                "name": info.get("name", ""),
            })
        lb_data = {
            "round_ts": round_ts,
            "round_end": round_end,
            "up": [_entry(a, s, a in hedged_addrs) for a, s in up_ranked[:100]],
            "down": [_entry(a, s, a in hedged_addrs) for a, s in dn_ranked[:100]],
            "up_total": round(up_total, 0),
            "dn_total": round(dn_total, 0),
            "up_count": len(up_ranked),
            "dn_count": len(dn_ranked),
            "hedged_count": len(hedged_addrs),
            "filter_makers": FILTER_MARKET_MAKERS,
            "scan_block": scan_block,
            "streak_up": streak_up,
            "streak_dn": streak_dn,
            "hot_streaks": hot_streaks,
            "hot_streak_stats": {
                k: hot_stats[k] for k in (
                    "up_n", "dn_n", "total", "up_pct", "dn_pct",
                    "up_shares", "dn_shares", "up_share_pct", "dn_share_pct",
                )
            },
            "round_stats": _round_invest_stats(len(up_ranked), len(dn_ranked), up_total, dn_total),
            "streak_min_rounds": STREAK_MIN_ROUNDS,
        }
        # 上轮赢家统计
        if follow_stats:
            lb_data["winners"] = {
                "side": follow_stats["prev_side"],
                "total": follow_stats["prev_total"],
                "up_n": follow_stats["up_n"],
                "dn_n": follow_stats["dn_n"],
                "up_s": follow_stats["up_s"],
                "dn_s": follow_stats["dn_s"],
                "net_dir": follow_stats["net_dir"],
                "net_shares": follow_stats["net_shares"],
                "majority_side": follow_stats["majority_side"],
            }
        try:
            import quick_trade
            with quick_trade.state_lock:
                quick_trade.state["winner_follow_current"] = {
                    "round_ts": round_ts,
                    "stats": follow_stats,
                }
        except Exception:
            pass
        # 4连胜统计
        if _streak_list:
            sl_up_lb = len(_streak_list & {a for a, _ in up_ranked})
            sl_dn_lb = len(_streak_list & {a for a, _ in dn_ranked})
            lb_data["streak4"] = {"total": len(_streak_list), "up": sl_up_lb, "dn": sl_dn_lb}
        with quick_trade.state_lock:
            quick_trade.state["leaderboard"] = lb_data
            quick_trade.state["_lb_tids_5m"] = dict(token_ids)
            quick_trade.state["token_ids"] = dict(token_ids)
            # 嵌入模式下以链上扫描回合为准，避免与 state_worker 错位
            quick_trade.state["round_ts"] = round_ts
            quick_trade.state["round_end"] = round_end
        with _btc_price_lock:
            strike = float(_btc_prices.get("strike") or 0)
            current_px = float(_btc_prices.get("current") or 0)
            up_px = float(_btc_prices.get("up_price") or 0)
            dn_px = float(_btc_prices.get("down_price") or 0)
        with quick_trade.state_lock:
            if strike > 0:
                quick_trade.state["strike"] = strike
            if current_px > 0:
                quick_trade.state["crypto_current"] = current_px
            if up_px > 0:
                quick_trade.state["up_price"] = up_px
            if dn_px > 0:
                quick_trade.state["down_price"] = dn_px
            bp5 = (quick_trade.state.get("board_prices") or {}).get("5m") or {}
            if bp5.get("up"):
                quick_trade.state["up_price"] = float(bp5["up"])
            if bp5.get("down"):
                quick_trade.state["down_price"] = float(bp5["down"])

        # ── 15m / 1h 排行榜 ──
        for tf_key in ("15m", "1h"):
            tf_tids = quick_trade.state.get(f"_lb_tids_{tf_key}")
            if not tf_tids:
                continue
            tf_up, tf_dn, tf_hedged = net_positions(balances, tf_tids)
            tf_up_total = sum(s for _, s in tf_up)
            tf_dn_total = sum(s for _, s in tf_dn)
            tf_hot_stats = _hot_streak_stats(tf_up, tf_dn)
            tf_hot = []
            for h in tf_hot_stats["items"]:
                info = get_user_info(h["addr"])
                tf_hot.append({**h, "name": info.get("name", "")})
            tf_data = {
                "up": [_entry(a, s, a in tf_hedged) for a, s in tf_up[:100]],
                "down": [_entry(a, s, a in tf_hedged) for a, s in tf_dn[:100]],
                "up_total": round(tf_up_total, 0),
                "dn_total": round(tf_dn_total, 0),
                "up_count": len(tf_up),
                "dn_count": len(tf_dn),
                "hedged_count": len(tf_hedged),
                "filter_makers": FILTER_MARKET_MAKERS,
                "scan_block": scan_block,
                "hot_streaks": tf_hot,
                "hot_streak_stats": {
                    k: tf_hot_stats[k] for k in (
                        "up_n", "dn_n", "total", "up_pct", "dn_pct",
                        "up_shares", "dn_shares", "up_share_pct", "dn_share_pct",
                    )
                },
                "round_stats": _round_invest_stats(len(tf_up), len(tf_dn), tf_up_total, tf_dn_total),
                "streak_min_rounds": STREAK_MIN_ROUNDS,
            }
            quick_trade.state[f"leaderboard_{tf_key}"] = tf_data
    except Exception:
        pass



# ── 上轮赢家跟踪 ──────────────────────────────────────────────────────────────
SAVE_DIR = os.path.join(os.path.dirname(__file__), "持仓")
WINNER_RECORDS_FILE = os.path.join(SAVE_DIR, "winner_records.json")
_last_round_winners = {}  # {addr: net_shares}  上轮赢家地址及净持仓
_last_round_winner_side = ""  # "up" or "down"
_winner_records = []


def _cs_addr(addr: str) -> str:
    try:
        return Web3.to_checksum_address(addr[:42] if len(addr) >= 42 else addr)
    except Exception:
        return addr.lower()


def compute_winner_follow_stats(up_ranked, dn_ranked, balances=None, token_ids=None):
    """统计上轮赢家在本轮 UP/DOWN 方向的分布 (每人只计一次)"""
    if not _last_round_winners:
        return None

    up_map = {_cs_addr(a): s for a, s in up_ranked}
    dn_map = {_cs_addr(a): s for a, s in dn_ranked}

    up_raw = {}
    dn_raw = {}
    if balances and token_ids:
        up_tid = token_ids.get("up")
        dn_tid = token_ids.get("down")
        if up_tid and up_tid in balances:
            # list() 快照，避免扫描线程并发修改触发 RuntimeError
            up_raw = {_cs_addr(a): s for a, s in list(balances[up_tid].items()) if s > 0.5}
        if dn_tid and dn_tid in balances:
            dn_raw = {_cs_addr(a): s for a, s in list(balances[dn_tid].items()) if s > 0.5}

    w_up_n = w_dn_n = 0
    w_up_s = w_dn_s = 0.0

    for addr in _last_round_winners:
        a = _cs_addr(addr)
        u = up_raw.get(a, 0) if up_raw else up_map.get(a, 0)
        d = dn_raw.get(a, 0) if dn_raw else dn_map.get(a, 0)

        if up_raw or dn_raw:
            if u <= 0.5 and d <= 0.5:
                continue
            if u > 0.5 and d > 0.5:
                if u >= d:
                    w_up_n += 1
                    w_up_s += u - d
                else:
                    w_dn_n += 1
                    w_dn_s += d - u
            elif u > 0.5:
                w_up_n += 1
                w_up_s += u
            else:
                w_dn_n += 1
                w_dn_s += d
        else:
            in_up = a in up_map
            in_dn = a in dn_map
            if in_up and in_dn:
                if up_map[a] >= dn_map[a]:
                    w_up_n += 1
                    w_up_s += up_map[a]
                else:
                    w_dn_n += 1
                    w_dn_s += dn_map[a]
            elif in_up:
                w_up_n += 1
                w_up_s += up_map[a]
            elif in_dn:
                w_dn_n += 1
                w_dn_s += dn_map[a]

    net_s = abs(w_up_s - w_dn_s)
    net_dir = "UP" if w_up_s > w_dn_s else "DN" if w_dn_s > w_up_s else "--"
    if w_up_n > w_dn_n:
        majority_side = "UP"
    elif w_dn_n > w_up_n:
        majority_side = "DN"
    else:
        majority_side = "TIE"
    return {
        "prev_side": _last_round_winner_side,
        "prev_total": len(_last_round_winners),
        "up_n": w_up_n,
        "dn_n": w_dn_n,
        "up_s": round(w_up_s, 0),
        "dn_s": round(w_dn_s, 0),
        "net_dir": net_dir,
        "net_shares": round(net_s, 0),
        "majority_side": majority_side,
        "present_n": w_up_n + w_dn_n,
    }


def _normalize_side(side: str) -> str:
    """统一 UP/DOWN 方向命名 (DN → down)"""
    if not side:
        return ""
    s = side.lower().strip()
    if s in ("dn", "down"):
        return "down"
    if s == "up":
        return "up"
    return s


def _majority_won(majority_side: str, actual_winner: str):
    if not actual_winner or actual_winner == "unknown":
        return None
    if majority_side == "TIE":
        return None
    return _normalize_side(majority_side) == _normalize_side(actual_winner)


def load_winner_records():
    global _winner_records
    try:
        with open(WINNER_RECORDS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        _winner_records = data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        _winner_records = []
    # 修正历史记录中 DN/DOWN 不一致导致的输赢误判
    changed = False
    for rec in _winner_records:
        aw = rec.get("actual_winner")
        if aw:
            fixed = _majority_won(rec.get("majority_side", ""), aw)
            if rec.get("majority_won") != fixed:
                rec["majority_won"] = fixed
                changed = True
    if changed:
        _persist_winner_records()
    return _winner_records


def _persist_winner_records():
    os.makedirs(SAVE_DIR, exist_ok=True)
    with open(WINNER_RECORDS_FILE, "w", encoding="utf-8") as f:
        json.dump(_winner_records, f, ensure_ascii=False, indent=2)


def _sync_winner_records_to_state():
    try:
        import quick_trade
        with quick_trade.state_lock:
            quick_trade.state["winner_records"] = list(_winner_records)
    except Exception:
        pass


def upsert_winner_record(round_ts: int, stats: dict, actual_winner: str = None):
    """写入或更新一局跟随记录"""
    global _winner_records
    if not stats:
        return None
    round_time = datetime.fromtimestamp(round_ts).strftime("%H:%M")
    aw = actual_winner.lower() if actual_winner and actual_winner != "unknown" else None
    entry = {
        "round_ts": round_ts,
        "round_time": round_time,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        **stats,
        "actual_winner": _normalize_side(aw).upper() if aw else None,
        "majority_won": _majority_won(stats["majority_side"], aw) if aw else None,
    }
    for i, rec in enumerate(_winner_records):
        if rec.get("round_ts") == round_ts:
            prev = _winner_records[i]
            if aw and not prev.get("actual_winner"):
                entry["recorded_at"] = prev.get("recorded_at", entry["recorded_at"])
            elif prev.get("actual_winner") and not aw:
                entry["actual_winner"] = prev["actual_winner"]
                entry["majority_won"] = prev.get("majority_won")
                entry["recorded_at"] = prev.get("recorded_at", entry["recorded_at"])
            _winner_records[i] = entry
            _persist_winner_records()
            _sync_winner_records_to_state()
            return entry
    _winner_records.append(entry)
    _winner_records.sort(key=lambda r: r.get("round_ts", 0), reverse=True)
    if len(_winner_records) > 200:
        _winner_records = _winner_records[:200]
    _persist_winner_records()
    _sync_winner_records_to_state()
    return entry


def record_winner_follow_round(round_ts: int, up_ranked, dn_ranked, actual_winner: str = None, balances=None, token_ids=None):
    stats = compute_winner_follow_stats(up_ranked, dn_ranked, balances, token_ids)
    if not stats:
        return None
    return upsert_winner_record(round_ts, stats, actual_winner)


load_winner_records()
_sync_winner_records_to_state()


def get_streak_count(addr: str) -> int:
    """返回地址的连续盈利回合数 (0 = 无连胜)"""
    try:
        cs = Web3.to_checksum_address(addr)
    except Exception:
        cs = addr
    return _hot_streak_map.get(cs, 0)


def compute_hot_streaks():
    """从 持仓/*-blocks.csv 计算连续押中赢家方向的地址"""
    global _hot_streak_map
    import glob
    import re
    import csv as csv_mod

    reload_streak_list()
    csv_files = sorted(glob.glob(os.path.join(SAVE_DIR, "*-blocks.csv")))
    rounds = []

    for cf in csv_files:
        fn = os.path.basename(cf)
        m = re.match(r"\d{4}-\d{4}-(up|down)-blocks\.csv", fn)
        if not m:
            continue
        winner = m.group(1)
        addrs = set()
        try:
            with open(cf, encoding="utf-8") as f:
                reader = csv_mod.DictReader(f)
                for row in reader:
                    if row.get("方向") != winner:
                        continue
                    addr = (row.get("地址") or "").strip()
                    if not addr.startswith("0x") or len(addr) < 42:
                        continue
                    try:
                        addrs.add(Web3.to_checksum_address(addr[:42]))
                    except Exception:
                        addrs.add(addr[:42])
        except OSError:
            continue
        rounds.append(addrs)

    streak_map = {}
    if rounds:
        all_addrs = set()
        for win_set in rounds:
            all_addrs |= win_set
        for addr in all_addrs:
            streak = 0
            for win_set in reversed(rounds):
                if addr in win_set:
                    streak += 1
                else:
                    break
            if streak >= STREAK_MIN_ROUNDS:
                streak_map[addr] = streak

    for addr in _streak_list:
        streak_map[addr] = max(streak_map.get(addr, 0), 4)

    _hot_streak_map = streak_map


def _hot_streaks_in_round(up_ranked, dn_ranked):
    """本轮排行榜中的连胜地址"""
    seen = set()
    items = []
    for addr, shares in up_ranked:
        sc = get_streak_count(addr)
        if sc >= STREAK_MIN_ROUNDS and addr not in seen:
            seen.add(addr)
            items.append({"addr": addr, "side": "UP", "shares": shares, "count": sc})
    for addr, shares in dn_ranked:
        sc = get_streak_count(addr)
        if sc >= STREAK_MIN_ROUNDS and addr not in seen:
            seen.add(addr)
            items.append({"addr": addr, "side": "DN", "shares": shares, "count": sc})
    items.sort(key=lambda x: (-x["count"], -x["shares"]))
    return items


def _hot_streak_stats(up_ranked, dn_ranked):
    """连胜地址 UP/DOWN 人数与比例"""
    items = _hot_streaks_in_round(up_ranked, dn_ranked)
    up_n = sum(1 for h in items if h["side"] == "UP")
    dn_n = sum(1 for h in items if h["side"] == "DN")
    total = up_n + dn_n
    up_shares = sum(h["shares"] for h in items if h["side"] == "UP")
    dn_shares = sum(h["shares"] for h in items if h["side"] == "DN")
    share_total = up_shares + dn_shares
    return {
        "items": items,
        "up_n": up_n,
        "dn_n": dn_n,
        "total": total,
        "up_pct": round(up_n / total * 100, 1) if total else 0,
        "dn_pct": round(dn_n / total * 100, 1) if total else 0,
        "up_shares": round(up_shares, 0),
        "dn_shares": round(dn_shares, 0),
        "up_share_pct": round(up_shares / share_total * 100, 1) if share_total else 0,
        "dn_share_pct": round(dn_shares / share_total * 100, 1) if share_total else 0,
    }


def _format_hot_streak_ratio(stats: dict) -> str:
    if not stats or not stats.get("total"):
        return ""
    arrow = "🟢" if stats["up_n"] > stats["dn_n"] else "🔴" if stats["dn_n"] > stats["up_n"] else "⚪"
    return (
        f"{arrow} UP {stats['up_n']}人({stats['up_pct']}%) "
        f"vs DN {stats['dn_n']}人({stats['dn_pct']}%)"
        f" | 股比 UP {stats['up_share_pct']}% / DN {stats['dn_share_pct']}%"
    )


def _round_invest_stats(up_count: int, dn_count: int, up_total: float, dn_total: float) -> dict:
    """本轮链上投入 UP/DOWN 人数与股数比例"""
    total_n = up_count + dn_count
    total_s = up_total + dn_total
    return {
        "up_n": up_count,
        "dn_n": dn_count,
        "total_n": total_n,
        "up_pct": round(up_count / total_n * 100, 1) if total_n else 0,
        "dn_pct": round(dn_count / total_n * 100, 1) if total_n else 0,
        "up_shares": round(up_total, 0),
        "dn_shares": round(dn_total, 0),
        "total_shares": round(total_s, 0),
        "up_share_pct": round(up_total / total_s * 100, 1) if total_s else 0,
        "dn_share_pct": round(dn_total / total_s * 100, 1) if total_s else 0,
    }


def _format_round_invest(stats: dict) -> str:
    if not stats or not stats.get("total_n"):
        return ""
    arrow = "🟢" if stats["up_n"] > stats["dn_n"] else "🔴" if stats["dn_n"] > stats["up_n"] else "⚪"
    return (
        f"{arrow} UP {stats['up_n']}人({stats['up_pct']}%) "
        f"vs DN {stats['dn_n']}人({stats['dn_pct']}%)"
    )


def load_last_round_winners():
    """从持仓目录读取最新 CSV, 提取赢家地址 + 计算连胜"""
    global _last_round_winners, _last_round_winner_side
    import glob
    import re
    import csv as csv_mod
    csv_files = sorted(glob.glob(os.path.join(SAVE_DIR, "*-blocks.csv")))
    if not csv_files:
        compute_hot_streaks()
        return

    # 最新一轮赢家
    latest = csv_files[-1]
    fname = os.path.basename(latest)
    m = re.match(r"\d{4}-\d{4}-(up|down)-blocks\.csv", fname)
    if not m:
        compute_hot_streaks()
        return
    winner = m.group(1)
    addrs = {}
    with open(latest, encoding="utf-8") as f:
        reader = csv_mod.DictReader(f)
        for row in reader:
            if row["方向"] == winner:
                addr = row["地址"].strip()
                if addr.startswith("0x") and len(addr) >= 42:
                    addrs[_cs_addr(addr)] = float(row["持仓"])
    _last_round_winners = addrs
    _last_round_winner_side = winner
    compute_hot_streaks()

# ── 回合结算 + 保存 ──────────────────────────────────────────────────────────
_save_status = ""  # 用于在看板底部显示保存状态


def get_round_winner(round_ts: int, timeout: int = 120) -> str:
    """通过 crypto-price API 快速判断赢家 (通常 <10s)
    原理: 拿到 strike 价和结算价，比较大小即可判断 UP/DOWN"""
    global _save_status
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(max_retries=3)
    session.mount("https://", adapter)

    round_end = round_ts + ROUND_DURATION
    deadline = time.time() + timeout
    attempt = 0

    # 先等回合实际结束
    now = time.time()
    if now < round_end + 5:
        wait = round_end + 5 - now
        _save_status = f"⏳ 等待回合 {datetime.fromtimestamp(round_ts).strftime('%H:%M')} 结束 ({wait:.0f}s)"
        time.sleep(max(0, wait))

    # 1. 获取 strike (本回合开盘价)
    from datetime import timezone as tz
    start_iso = datetime.fromtimestamp(round_ts, tz=tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_iso = datetime.fromtimestamp(round_end, tz=tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    strike = 0.0
    while time.time() < deadline and strike <= 0:
        attempt += 1
        try:
            url = f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime={start_iso}&variant=fiveminute&endDate={end_iso}"
            data = _robust_get_json(session, url, timeout=10, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
            })
            if data:
                strike = float(data.get("openPrice") or 0)
        except Exception:
            pass
        if strike <= 0:
            _save_status = f"⏳ 获取 strike 第{attempt}次..."
            time.sleep(2)

    if strike <= 0:
        _save_status = f"❌ 无法获取 strike，回退到 Gamma API"
        return _get_round_winner_gamma(round_ts, timeout=180)

    # 2. 获取结算价 (下一回合的 strike 就是本回合的结算价)
    next_start_iso = datetime.fromtimestamp(round_end, tz=tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    next_end_iso = datetime.fromtimestamp(round_end + ROUND_DURATION, tz=tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    resolution = 0.0
    while time.time() < deadline and resolution <= 0:
        attempt += 1
        try:
            url = f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime={next_start_iso}&variant=fiveminute&endDate={next_end_iso}"
            data = _robust_get_json(session, url, timeout=10, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
            })
            if data:
                resolution = float(data.get("openPrice") or 0)
        except Exception:
            pass
        if resolution <= 0:
            _save_status = f"⏳ 等待结算价 (strike=${strike:.2f})..."
            time.sleep(3)

    if resolution <= 0:
        _save_status = f"❌ 无法获取结算价，回退到 Gamma API"
        return _get_round_winner_gamma(round_ts, timeout=180)

    # 3. 判断赢家
    winner = "up" if resolution > strike else "down"
    _save_status = f"📊 strike=${strike:.2f} → ${resolution:.2f} → {winner.upper()}"
    return winner


def _get_round_winner_gamma(round_ts: int, timeout: int = 180) -> str:
    """回退: 通过 Gamma API 获取赢家 (慢, 需要 2-3 分钟)"""
    global _save_status
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(max_retries=3)
    session.mount("https://", adapter)

    slug = f"btc-updown-5m-{round_ts}"
    deadline = time.time() + timeout
    attempt = 0

    while time.time() < deadline:
        attempt += 1
        try:
            r = session.get(
                "https://gamma-api.polymarket.com/events",
                params={"slug": slug}, timeout=15,
                verify=False,
            )
            events = r.json()
            if events and isinstance(events, list):
                mkt = events[0].get("markets", [{}])[0]
                prices = mkt.get("outcomePrices", "")
                if isinstance(prices, str):
                    try:
                        prices = json.loads(prices)
                    except Exception:
                        prices = []
                outcomes = mkt.get("outcomes", [])
                if isinstance(outcomes, str):
                    outcomes = json.loads(outcomes)
                for i, p in enumerate(prices):
                    if float(p) > 0.9 and i < len(outcomes):
                        return outcomes[i].lower()
        except Exception:
            pass
        _save_status = f"⏳ Gamma回退: 等待结算 (第{attempt}次)..."
        time.sleep(5)

    return "unknown"


def save_round_file(round_ts: int, balances_snapshot: dict, token_ids: dict, block_map: dict = None):
    """后台线程: 等待结算 → 保存持仓 + 区块信息"""
    global _save_status

    round_time = datetime.fromtimestamp(round_ts)
    _save_status = f"⏳ 等待回合 {round_time.strftime('%H:%M')} 结算..."

    # 1. 等待赢家
    winner = get_round_winner(round_ts)

    # 2. 生成文件名: 0411-1855-up.txt
    fname = f"{round_time.strftime('%m%d-%H%M')}-{winner}.txt"
    fpath = os.path.join(SAVE_DIR, fname)
    os.makedirs(SAVE_DIR, exist_ok=True)

    # 3. 净额计算
    up_ranked, dn_ranked, hedged_addrs = net_positions(balances_snapshot, token_ids)
    up_total = sum(s for _, s in up_ranked)
    dn_total = sum(s for _, s in dn_ranked)

    # 记录上轮赢家跟随统计 + 本局结果
    record_winner_follow_round(round_ts, up_ranked, dn_ranked, winner, balances_snapshot, token_ids)

    # 获取 token_id → side 映射
    tid_to_side = {}
    for side, tid in token_ids.items():
        tid_to_side[tid] = side

    # 合并所有 token 的 block_map: addr -> {side: [blocks]}
    addr_blocks = defaultdict(lambda: defaultdict(list))
    if block_map:
        for tid, addr_map in block_map.items():
            side = tid_to_side.get(tid, "?")
            for addr, blocks in addr_map.items():
                addr_blocks[addr.lower()][side].extend(blocks)

    # 4. 写 txt (同终端显示格式, 全部持仓 + 区块列)
    COL = 105
    DIV = " │ "

    lines = []
    lines.append("═" * (COL * 2 + len(DIV)))
    lines.append(f"  🏆 BTC 5m 链上持仓  |  回合 {round_time.strftime('%H:%M:%S')}  |  赢家: {winner.upper()}  |  📡 链上 maker+taker")
    if hedged_addrs:
        msg = _maker_filter_msg(hedged_addrs)
        if msg:
            lines.append(msg)
    # 上轮赢家在本轮的方向统计
    follow_stats = compute_winner_follow_stats(up_ranked, dn_ranked, balances_snapshot, token_ids)
    if follow_stats:
        side_label = follow_stats["prev_side"].upper() if follow_stats["prev_side"] else "?"
        net_dir = follow_stats["net_dir"]
        arrow = "🟢" if net_dir == "UP" else "🔴" if net_dir == "DN" else "⚪"
        lines.append(
            f"  🏅 上轮{side_label}赢家 {follow_stats['prev_total']}人 | "
            f"本轮: {follow_stats['up_n']}人UP({follow_stats['up_s']:,.0f}股) vs "
            f"{follow_stats['dn_n']}人DN({follow_stats['dn_s']:,.0f}股) | "
            f"{arrow} 净{net_dir} {follow_stats['net_shares']:,.0f}股"
        )
        maj = follow_stats["majority_side"]
        won = _majority_won(maj, winner)
        if won is True:
            lines.append(f"  ✅ 人多方向 {maj} → 本局 {winner.upper()} (押中)")
        elif won is False:
            lines.append(f"  ❌ 人多方向 {maj} → 本局 {winner.upper()} (未中)")
        elif maj == "TIE":
            lines.append(f"  ⚪ 人数持平 → 本局 {winner.upper()}")
    # 4连胜名单方向统计
    if _streak_list:
        up_addrs_sl = {a for a, _ in up_ranked}
        dn_addrs_sl = {a for a, _ in dn_ranked}
        sl_up = len(_streak_list & up_addrs_sl)
        sl_dn = len(_streak_list & dn_addrs_sl)
        sl_arrow = "🟢" if sl_up > sl_dn else "🔴" if sl_dn > sl_up else "⚪"
        lines.append(f"  📊 4连胜名单 {len(_streak_list)}人 | 本轮: {sl_up}人UP vs {sl_dn}人DN | {sl_arrow}")
    hot_stats = _hot_streak_stats(up_ranked, dn_ranked)
    hot_items = hot_stats["items"]
    if hot_items:
        ratio = _format_hot_streak_ratio(hot_stats)
        parts = []
        for h in hot_items[:10]:
            short = h["addr"][:6] + ".." + h["addr"][-4:]
            parts.append(f"{short} 🔥{h['count']} {h['side']} {h['shares']:,.0f}股")
        lines.append(f"  🔥 连胜冒火 (本轮 {hot_stats['total']}人): {ratio}")
        lines.append(f"     " + " | ".join(parts))
    lines.append("═" * (COL * 2 + len(DIV)))

    up_hdr = f"  🟢 UP (涨)  {len(up_ranked)}人  净总计 {up_total:,.0f}股"
    dn_hdr = f"  🔴 DOWN (跌)  {len(dn_ranked)}人  净总计 {dn_total:,.0f}股"
    lines.append(f"{up_hdr:<{COL}}{DIV}{dn_hdr:<{COL}}")
    lines.append(f"{'─' * COL}{DIV}{'─' * COL}")

    max_rows = max(len(up_ranked), len(dn_ranked))
    for i in range(max_rows):
        if i < len(up_ranked):
            addr, shares = up_ranked[i]
            pct = shares / up_total * 100 if up_total > 0 else 0
            left = format_entry(i + 1, addr, shares, pct, addr in hedged_addrs, get_streak_count(addr))
        else:
            left = ""

        if i < len(dn_ranked):
            addr, shares = dn_ranked[i]
            pct = shares / dn_total * 100 if dn_total > 0 else 0
            right = format_entry(i + 1, addr, shares, pct, addr in hedged_addrs, get_streak_count(addr))
        else:
            right = ""

        lines.append(f"{left:<{COL}}{DIV}{right}")

    lines.append(f"{'─' * COL}{DIV}{'─' * COL}")

    with open(fpath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    # 5. 写区块信息 CSV (用于小号聚类分析)
    if block_map:
        csv_name = f"{round_time.strftime('%m%d-%H%M')}-{winner}-blocks.csv"
        csv_path = os.path.join(SAVE_DIR, csv_name)

        # 合并排名信息
        all_addrs = {}
        for side_list, side_name in [(up_ranked, "up"), (dn_ranked, "down")]:
            for rank, (addr, shares) in enumerate(side_list, 1):
                all_addrs[addr.lower()] = {
                    "addr": addr, "side": side_name,
                    "rank": rank, "shares": shares,
                    "hedged": addr in hedged_addrs,
                }

        with open(csv_path, "w", encoding="utf-8") as f:
            f.write("地址,方向,排名,持仓,对冲,买入区块\n")
            for addr_lower, info in sorted(all_addrs.items(), key=lambda x: x[1]["rank"]):
                side_map = addr_blocks.get(addr_lower, {})
                side_blocks = sorted(set(side_map.get(info['side'], [])))
                blocks_str = "|".join(str(b) for b in side_blocks)
                hedge = "⚖️" if info["hedged"] else ""
                f.write(f"{info['addr']},{info['side']},{info['rank']},{info['shares']:.0f},{hedge},{blocks_str}\n")

    _save_status = f"✅ 已保存 {fname} ({len(up_ranked)}+{len(dn_ranked)} 人)"
    load_last_round_winners()


# ── 主循环 ────────────────────────────────────────────────────────────────────
def main():

    import argparse

    parser = argparse.ArgumentParser(description="链上持仓排行榜")
    parser.add_argument("--once", action="store_true", help="只查一次")
    parser.add_argument("--ts", type=int, help="指定回合时间戳")
    parser.add_argument("--interval", type=int, default=5, help="显示刷新间隔(秒)")
    parser.add_argument("--top", type=int, default=20, help="显示前N名")
    parser.add_argument("--no-save", action="store_true", help="不保存持仓文件")
    parser.add_argument("--lookback", type=int, default=300,
                        help="往前扫描秒数 (捕捉提前布局, 默认 300s = 1个回合)")
    args = parser.parse_args()

    load_username_cache()
    # 启动用户名后台解析线程
    threading.Thread(target=_user_resolver_worker, daemon=True).start()
    w3 = get_w3()

    # 加载鲸鱼列表 (从 tracked_whales_list.txt)
    reload_tracked_whales()

    current_round_ts = args.ts or get_current_round_ts()
    round_end = current_round_ts + ROUND_DURATION

    print(f"🔍 获取回合 {datetime.fromtimestamp(current_round_ts).strftime('%H:%M:%S')} 的 token 信息...")
    token_ids = get_round_token_ids(current_round_ts)
    if not token_ids:
        print("❌ 无法获取回合 token_id，可能回合尚未创建")
        sys.exit(1)

    print(f"   UP  token: {token_ids.get('up', 'N/A')[:20]}...")
    print(f"   DOWN token: {token_ids.get('down', 'N/A')[:20]}...")

    target_set = set(token_ids.values())

    # ── 15m / 1h 额外 token_ids (共用同一套区块扫描) ──
    _extra_tids = {}  # {"15m": {"up": tid, "down": tid}, "1h": ...}
    now_ts = int(time.time())
    for tf_key, duration in [("15m", 900), ("1h", 3600)]:
        tf_round = now_ts - (now_ts % duration)
        tids = get_round_token_ids(tf_round, prefix=tf_key)
        if tids:
            _extra_tids[tf_key] = tids
            target_set |= set(tids.values())
            print(f"   {tf_key} tokens: UP={list(tids.values())[0][:16]}... DN={list(tids.values())[1][:16]}...")
        else:
            print(f"   ⚠️ {tf_key} token 获取失败, 跳过")


    # 计算起始区块 (往前 lookback 秒捕捉提前布局)
    scan_from_ts = current_round_ts - args.lookback
    start_block = ts_to_block(w3, scan_from_ts)
    last_scanned_block = start_block - 1

    print(f"   起始区块: {start_block} (往前 {args.lookback}s)")

    # 启动 BTC 实时价格 WebSocket (Polymarket RTDS Chainlink Data Streams)
    set_price_round(current_round_ts, token_ids)
    start_btc_price_feed()

    # 启动 Quick Trade 面板 (嵌入模式, 共享 RTDS 价格)
    try:
        import quick_trade
        quick_trade.start_embedded()
    except Exception as e:
        print(f"  ⚠️ Quick Trade 启动失败: {e}")

    print(f"   启动中...")

    # 加载上轮赢家 (从已保存的 CSV)
    load_last_round_winners()
    if _last_round_winners:
        print(f"   📂 已加载上轮 {_last_round_winner_side.upper()} 赢家 {len(_last_round_winners)} 人")

    # ── 共享状态 (扫描线程 ↔ 显示线程) ──
    _scan_lock = threading.Lock()
    cumulative_balances = defaultdict(lambda: defaultdict(float))
    cumulative_blocks = defaultdict(lambda: defaultdict(list))
    _scan_state = {
        "last_scanned_block": last_scanned_block,
        "current_round_ts": current_round_ts,
        "round_end": round_end,
        "token_ids": dict(token_ids),
        "target_set": set(target_set),
        "next_round_ts": current_round_ts + ROUND_DURATION,
        "next_token_ids": {},
        "extra_tids": dict(_extra_tids),  # 15m/1h token_ids
    }
    # 把 15m/1h token_ids 传给 quick_trade state 供 display_leaderboard 使用
    try:
        import quick_trade
        with quick_trade.state_lock:
            quick_trade.state["_lb_tids_5m"] = dict(token_ids)
            for tf_key, tids in _extra_tids.items():
                quick_trade.state[f"_lb_tids_{tf_key}"] = tids
    except Exception:
        pass

    def _scan_worker():
        """后台扫描线程: 持续扫描新区块（受 crawl 开关控制）"""
        was_enabled = False
        while True:
            if not is_crawl_enabled():
                was_enabled = False
                time.sleep(1)
                continue
            # 刚开启：从本回合起点重扫，避免跳过关闭期间区块导致持仓为空
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
                    print(f"   ⚠️ 爬取开启对齐区块失败: {e}", flush=True)
            try:
                with _scan_lock:
                    scan_from = _scan_state["last_scanned_block"] + 1
                    ts = _scan_state["target_set"]

                current_block = w3.eth.block_number
                if scan_from > current_block:
                    time.sleep(1)
                    continue

                # 落后过多时重同步，避免一次扫十万块卡死
                lag = current_block - scan_from + 1
                max_lag = max(500, int(args.lookback))
                max_per_loop = 300
                if lag > max_lag:
                    with _scan_lock:
                        floor = _scan_resync_floor(w3, current_block, _scan_state, args.lookback)
                        _scan_state["last_scanned_block"] = floor
                        cumulative_balances.clear()
                        cumulative_blocks.clear()
                    scan_from = floor + 1
                    lag = current_block - scan_from + 1
                    max_per_loop = min(max(lag, max_per_loop), 1500)
                    print(
                        f"   ⚠️ 扫描落后过多，重同步到区块 {scan_from} (tip={current_block})",
                        flush=True,
                    )

                scan_to = min(current_block, scan_from + max_per_loop - 1)

                # 当回合过半，预取下一回合 token
                now_ts = int(time.time())
                with _scan_lock:
                    rts = _scan_state["current_round_ts"]
                    nrt = _scan_state["next_round_ts"]
                    ntids = _scan_state["next_token_ids"]
                if now_ts >= rts + ROUND_DURATION * 2 // 5 and not ntids:
                    try:
                        nts = get_round_token_ids(nrt)
                        if nts:
                            with _scan_lock:
                                _scan_state["next_token_ids"] = nts
                                extra = set()
                                for tf_tids in _scan_state.get("extra_tids", {}).values():
                                    extra |= set(tf_tids.values())
                                _scan_state["target_set"] = set(_scan_state["token_ids"].values()) | set(nts.values()) | extra
                                ts = _scan_state["target_set"]
                    except Exception:
                        pass

                # 刷新 15m / 1h token_ids (各自回合可能已换)
                try:
                    for tf_key, duration in [("15m", 900), ("1h", 3600)]:
                        tf_round = now_ts - (now_ts % duration)
                        old_tids = _scan_state.get("extra_tids", {}).get(tf_key)
                        if old_tids:
                            # 检查是否已过期
                            old_vals = set(old_tids.values())
                        else:
                            old_vals = set()
                        # 每个回合只需刷新一次
                        new_tids = get_round_token_ids(tf_round, prefix=tf_key)
                        if new_tids and set(new_tids.values()) != old_vals:
                            with _scan_lock:
                                _scan_state.setdefault("extra_tids", {})[tf_key] = new_tids
                                extra_all = set()
                                for tf_tids_v in _scan_state["extra_tids"].values():
                                    extra_all |= set(tf_tids_v.values())
                                _scan_state["target_set"] = set(_scan_state["token_ids"].values()) | extra_all
                                if ntids:
                                    _scan_state["target_set"] |= set(ntids.values())
                                ts = _scan_state["target_set"]
                            try:
                                import quick_trade
                                quick_trade.state[f"_lb_tids_{tf_key}"] = new_tids
                            except Exception:
                                pass
                except Exception:
                    pass

                quiet = (scan_to - scan_from) < 10
                n_blocks = scan_to - scan_from + 1
                logs = scan_transfers(w3, scan_from, scan_to, quiet=quiet)
                new_balances, new_blocks = build_balances(logs, ts, w3)

                if not logs and n_blocks > 50:
                    # 大量区块但 0 条日志 → RPC 可能有问题
                    print(f"\n   ⚠️ 扫描 {scan_from}-{current_block} ({n_blocks}块) 返回 0 条日志, 可能 RPC 异常", flush=True)

                with _scan_lock:
                    for tid, holders in new_balances.items():
                        for addr, delta in holders.items():
                            cumulative_balances[tid][addr] += delta
                    for tid, addr_blocks in new_blocks.items():
                        for addr, blocks in addr_blocks.items():
                            cumulative_blocks[tid][addr].extend(blocks)
                    _scan_state["last_scanned_block"] = scan_to

            except Exception as e:
                import traceback
                print(f"\n   ❌ 扫描异常: {e}", flush=True)
                traceback.print_exc()
            time.sleep(3)

    # 启动扫描线程
    scan_thread = threading.Thread(target=_scan_worker, daemon=True)
    scan_thread.start()
    print(
        f"   爬取开关: {'🟢 已开启' if is_crawl_enabled() else '⏸ 已关闭（看板可手动开启）'}",
        flush=True,
    )

    try:
        while True:
            with _scan_lock:
                cur_block = _scan_state["last_scanned_block"]
                cur_round_ts = _scan_state["current_round_ts"]
                cur_round_end = _scan_state["round_end"]
                cur_token_ids = dict(_scan_state["token_ids"])
                # 快照持仓，避免显示线程遍历时被扫描线程修改
                balances_snap = {
                    tid: dict(addr_map)
                    for tid, addr_map in cumulative_balances.items()
                }

            # 更新价格线程的回合时间
            set_price_round(cur_round_ts, cur_token_ids)

            display_leaderboard(
                balances_snap, cur_token_ids,
                cur_round_ts, cur_round_end, cur_block,
            )

            # 显示后台保存状态
            if _save_status:
                print(f"  📁 {_save_status}")

            if args.once:
                break

            # 检查是否进入新回合
            now = int(time.time())
            if now >= cur_round_end:
                # ── 回合结束: 后台保存持仓 (仅旧回合 token) ──
                # 记录本轮赢家地址 (用于下轮显示)
                with _scan_lock:
                    old_tids_set = set(cur_token_ids.values())
                    snapshot = {}
                    for tid in old_tids_set:
                        if tid in cumulative_balances:
                            snapshot[tid] = dict(cumulative_balances[tid])
                    blocks_snapshot = {}
                    for tid in old_tids_set:
                        if tid in cumulative_blocks:
                            blocks_snapshot[tid] = {a: list(bs) for a, bs in cumulative_blocks[tid].items()}
                old_token_ids = dict(cur_token_ids)
                old_round_ts = cur_round_ts

                if not args.no_save:

                    t = threading.Thread(
                        target=save_round_file,
                        args=(old_round_ts, snapshot, old_token_ids, blocks_snapshot),
                        daemon=True,
                    )
                    t.start()

                # ── 立即进入新回合 ──
                save_username_cache()
                reload_tracked_whales()  # 热重载鲸鱼列表
                new_round_ts = get_current_round_ts()
                new_round_end = new_round_ts + ROUND_DURATION

                # 优先用已预取的 token_ids
                with _scan_lock:
                    ntids = _scan_state["next_token_ids"]
                    nrt = _scan_state["next_round_ts"]
                if ntids and nrt == new_round_ts:
                    new_token_ids = ntids
                else:
                    new_token_ids = get_round_token_ids(new_round_ts)
                if not new_token_ids:
                    time.sleep(5)
                    continue

                # 保留 15m/1h 的 token_ids
                extra_tids_keep = set()
                with _scan_lock:
                    for tf_tids in _scan_state.get("extra_tids", {}).values():
                        extra_tids_keep |= set(tf_tids.values())

                new_target = set(new_token_ids.values()) | extra_tids_keep

                # 提取已预扫到的下一回合仓位
                with _scan_lock:
                    new_balances = defaultdict(lambda: defaultdict(float))
                    new_blocks_map = defaultdict(lambda: defaultdict(list))
                    for tid in new_target:
                        if tid in cumulative_balances:
                            new_balances[tid] = cumulative_balances[tid]
                        if tid in cumulative_blocks:
                            new_blocks_map[tid] = cumulative_blocks[tid]
                    # 原地替换共享数据
                    cumulative_balances.clear()
                    cumulative_balances.update(new_balances)
                    cumulative_blocks.clear()
                    cumulative_blocks.update(new_blocks_map)

                    _scan_state["current_round_ts"] = new_round_ts
                    _scan_state["round_end"] = new_round_end
                    _scan_state["token_ids"] = dict(new_token_ids)
                    _scan_state["target_set"] = new_target
                    _scan_state["next_round_ts"] = new_round_ts + ROUND_DURATION
                    _scan_state["next_token_ids"] = {}

                    has_new = False
                    new_tid_set = set(new_token_ids.values())
                    for tid in new_tid_set:
                        if any(s > 0.5 for s in new_balances.get(tid, {}).values()):
                            has_new = True
                            break
                    if not has_new:
                        backfill = max(0, ts_to_block(w3, new_round_ts - args.lookback) - 1)
                        if _scan_state["last_scanned_block"] > backfill:
                            _scan_state["last_scanned_block"] = backfill
                            print(
                                f"   🔁 新回合回扫区块 {backfill + 1} 起 (round={new_round_ts})",
                                flush=True,
                            )

                try:
                    import quick_trade
                    with quick_trade.state_lock:
                        quick_trade.state["_lb_tids_5m"] = dict(new_token_ids)
                        quick_trade.state["token_ids"] = dict(new_token_ids)
                        quick_trade.state["round_ts"] = new_round_ts
                        quick_trade.state["round_end"] = new_round_end
                        quick_trade.state["strike"] = 0
                        quick_trade.state["leaderboard"] = {
                            "round_ts": new_round_ts,
                            "round_end": new_round_end,
                            "up": [],
                            "down": [],
                            "up_count": 0,
                            "dn_count": 0,
                            "up_total": 0,
                            "dn_total": 0,
                            "scan_block": _scan_state["last_scanned_block"],
                        }
                except Exception:
                    pass

                set_price_round(new_round_ts, new_token_ids)

            # ── 等 1 秒后重绘 (倒计时/价格秒级刷新) ──
            time.sleep(1)

    except KeyboardInterrupt:
        print("\n\n👋 已退出")
        save_username_cache()


if __name__ == "__main__":
    main()
