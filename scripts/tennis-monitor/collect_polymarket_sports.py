#!/usr/bin/env python3
"""从 Polymarket Gamma 拉取 NBA / Dota 对阵赛事 → 本地 txt + 可点详情的 HTML。

用法:
  python collect_polymarket_sports.py              # 两个都采 → txt + html
  python collect_polymarket_sports.py --sport nba
  python collect_polymarket_sports.py --html-only  # 不请求 API，用已有 txt 重建 html

输出（gitignore: scripts/tennis-monitor/output/）:
  output/polymarket_nba_YYYY-MM-DD.txt
  output/polymarket_dota_YYYY-MM-DD.txt
  output/polymarket_sports_YYYY-MM-DD.html
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from tm.env import load_monitor_env

load_monitor_env()

from tm.clients.polymarket import (  # noqa: E402
    fetch_polymarket_dota_events,
    fetch_polymarket_nba_events,
)

OUT_DIR = Path(__file__).resolve().parent / "output"


def _today_bj() -> str:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    except Exception:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _cell(v: Any) -> str:
    s = "" if v is None else str(v)
    return s.replace("\t", " ").replace("\n", " ").replace("\r", " ").strip()


def _price_pair(item: dict[str, Any]) -> tuple[str, str]:
    prices = item.get("prices")
    if not isinstance(prices, (list, tuple)) or len(prices) < 2:
        return "", ""
    try:
        a = f"{float(prices[0]):.4f}"
        b = f"{float(prices[1]):.4f}"
        return a, b
    except (TypeError, ValueError):
        return "", ""


def _start_ms_str(item: dict[str, Any]) -> str:
    start_ms = item.get("startMs")
    if start_ms is None or (isinstance(start_ms, float) and start_ms != start_ms):
        return ""
    try:
        return str(int(float(start_ms)))
    except (TypeError, ValueError):
        return ""


def item_to_row(item: dict[str, Any]) -> dict[str, Any]:
    pa, pb = _price_pair(item)
    return {
        "slug": _cell(item.get("slug")),
        "url": _cell(item.get("url")),
        "title": _cell(item.get("title")),
        "sideA": _cell(item.get("sideA")),
        "sideB": _cell(item.get("sideB")),
        "priceA": pa,
        "priceB": pb,
        "closed": bool(item.get("closed")),
        "startMs": _start_ms_str(item),
    }


def write_sport_txt(sport: str, items: list[dict[str, Any]], *, day: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"polymarket_{sport}_{day}.txt"
    fetched_at = datetime.now(timezone.utc).isoformat()
    rows = [item_to_row(it) for it in items]
    lines = [
        f"# sport={sport} fetched_at={fetched_at} count={len(rows)}",
        "# slug\turl\ttitle\tsideA\tsideB\tpriceA\tpriceB\tclosed\tstartMs",
    ]
    for r in rows:
        lines.append(
            "\t".join(
                [
                    r["slug"],
                    r["url"],
                    r["title"],
                    r["sideA"],
                    r["sideB"],
                    r["priceA"],
                    r["priceB"],
                    "1" if r["closed"] else "0",
                    r["startMs"],
                ]
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def read_sport_txt(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 9:
            continue
        rows.append(
            {
                "slug": parts[0],
                "url": parts[1],
                "title": parts[2],
                "sideA": parts[3],
                "sideB": parts[4],
                "priceA": parts[5],
                "priceB": parts[6],
                "closed": parts[7] == "1",
                "startMs": parts[8],
            }
        )
    return rows


def write_sports_html(
    *,
    day: str,
    nba: list[dict[str, Any]],
    dota: list[dict[str, Any]],
    fetched_at: str | None = None,
) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"polymarket_sports_{day}.html"
    payload = {
        "day": day,
        "fetched_at": fetched_at or datetime.now(timezone.utc).isoformat(),
        "nba": nba,
        "dota": dota,
    }
    data_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    html = _HTML_TEMPLATE.replace("__DATA_JSON__", data_json).replace("__DAY__", day)
    path.write_text(html, encoding="utf-8")
    return path


_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PM Sports · __DAY__</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #f3f0e8;
      --ink: #1a1f16;
      --muted: #5c6554;
      --line: #d5d0c4;
      --card: #fffcf5;
      --nba: #c45c26;
      --dota: #2a6b5a;
      --accent: #c45c26;
      --ok: #2f6b3a;
      --closed: #8a4b3a;
      --drawer: #161a14;
      --drawer-ink: #f3f0e8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "DM Sans", system-ui, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(ellipse 80% 50% at 10% -10%, rgba(196,92,38,.18), transparent 55%),
        radial-gradient(ellipse 60% 40% at 100% 0%, rgba(42,107,90,.14), transparent 50%),
        var(--bg);
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 18px 80px; }
    header {
      display: grid;
      gap: 10px;
      margin-bottom: 22px;
      animation: rise .5s ease both;
    }
    .brand {
      font-family: "Archivo Black", sans-serif;
      font-size: clamp(2rem, 5vw, 3.1rem);
      letter-spacing: -.02em;
      line-height: .95;
      text-transform: uppercase;
    }
    .brand span { color: var(--accent); }
    .sub { color: var(--muted); font-size: .95rem; max-width: 42rem; }
    .toolbar {
      display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
      margin: 18px 0 14px;
    }
    .tabs { display: flex; gap: 6px; }
    .tab {
      border: 1px solid var(--line);
      background: var(--card);
      color: var(--ink);
      font: inherit;
      font-weight: 700;
      padding: 8px 14px;
      border-radius: 999px;
      cursor: pointer;
    }
    .tab[aria-selected="true"][data-sport="nba"] {
      background: var(--nba); color: #fff; border-color: var(--nba);
    }
    .tab[aria-selected="true"][data-sport="dota"] {
      background: var(--dota); color: #fff; border-color: var(--dota);
    }
    .search {
      flex: 1 1 220px;
      min-width: 180px;
      border: 1px solid var(--line);
      background: var(--card);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      outline: none;
    }
    .search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(196,92,38,.15); }
    .meta { color: var(--muted); font-size: .85rem; margin-left: auto; }
    .list {
      display: grid;
      gap: 8px;
      animation: rise .55s .05s ease both;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px 14px;
      align-items: center;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px 14px;
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: inherit;
      transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
    }
    .row:hover, .row:focus-visible {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
      box-shadow: 0 8px 24px rgba(26,31,22,.06);
      outline: none;
    }
    .title { font-weight: 700; line-height: 1.25; }
    .sides { color: var(--muted); font-size: .9rem; margin-top: 4px; }
    .prices {
      display: flex; gap: 8px; align-items: center; justify-content: flex-end;
      font-variant-numeric: tabular-nums; font-weight: 700;
    }
    .pill {
      min-width: 3.4rem; text-align: center;
      padding: 6px 8px; border-radius: 10px;
      background: #ebe6da; font-size: .85rem;
    }
    .pill.hot { background: color-mix(in srgb, var(--accent) 18%, #fff); color: var(--nba); }
    .badge {
      display: inline-block; margin-left: 8px;
      font-size: .72rem; font-weight: 700; letter-spacing: .04em;
      padding: 2px 7px; border-radius: 999px; vertical-align: middle;
      text-transform: uppercase;
    }
    .badge.closed { background: color-mix(in srgb, var(--closed) 18%, #fff); color: var(--closed); }
    .badge.open { background: color-mix(in srgb, var(--ok) 16%, #fff); color: var(--ok); }
    .empty { color: var(--muted); padding: 28px 8px; }
    .drawer-mask {
      position: fixed; inset: 0; background: rgba(22,26,20,.45);
      opacity: 0; pointer-events: none; transition: opacity .2s ease; z-index: 40;
    }
    .drawer-mask.open { opacity: 1; pointer-events: auto; }
    .drawer {
      position: fixed; top: 0; right: 0; height: 100%; width: min(420px, 100%);
      background: var(--drawer); color: var(--drawer-ink);
      transform: translateX(104%); transition: transform .28s cubic-bezier(.2,.8,.2,1);
      z-index: 50; padding: 22px 20px 28px; overflow: auto;
      box-shadow: -16px 0 40px rgba(0,0,0,.25);
    }
    .drawer.open { transform: translateX(0); }
    .drawer h2 {
      font-family: "Archivo Black", sans-serif;
      font-size: 1.35rem; line-height: 1.15; margin: 0 28px 14px 0;
      text-transform: uppercase; letter-spacing: -.01em;
    }
    .drawer .close {
      position: absolute; top: 14px; right: 14px;
      border: 0; background: transparent; color: var(--drawer-ink);
      font-size: 1.4rem; cursor: pointer; line-height: 1; padding: 6px;
    }
    .kv { display: grid; gap: 10px; margin-top: 8px; }
    .kv div {
      display: grid; gap: 3px;
      padding-bottom: 10px; border-bottom: 1px solid rgba(243,240,232,.12);
    }
    .kv dt { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; opacity: .55; }
    .kv dd { margin: 0; font-weight: 600; word-break: break-word; }
    .vs-board {
      display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px;
      align-items: center; margin: 16px 0 18px;
      padding: 14px; border-radius: 14px; background: rgba(255,255,255,.06);
    }
    .vs-board .side { text-align: center; }
    .vs-board .name { font-weight: 700; margin-bottom: 6px; }
    .vs-board .pct { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .vs-board .mid { opacity: .45; font-weight: 700; }
    .actions { display: flex; gap: 8px; margin-top: 18px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 11px 14px; border-radius: 12px; font: inherit; font-weight: 700;
      text-decoration: none; border: 0; cursor: pointer;
    }
    .btn.primary { background: var(--accent); color: #fff; flex: 1; }
    .btn.ghost { background: rgba(255,255,255,.08); color: var(--drawer-ink); }
    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }
    @media (max-width: 640px) {
      .row { grid-template-columns: 1fr; }
      .prices { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">PM <span>Sports</span> Board</div>
      <p class="sub">Polymarket 对阵赛事本地板 · __DAY__。点行打开详情，可跳转外链。</p>
    </header>
    <div class="toolbar">
      <div class="tabs" role="tablist">
        <button type="button" class="tab" data-sport="nba" role="tab" aria-selected="true">NBA</button>
        <button type="button" class="tab" data-sport="dota" role="tab" aria-selected="false">Dota</button>
      </div>
      <input class="search" id="q" type="search" placeholder="搜索队名 / 标题 / slug" />
      <div class="meta" id="meta"></div>
    </div>
    <div class="list" id="list"></div>
  </div>

  <div class="drawer-mask" id="mask"></div>
  <aside class="drawer" id="drawer" aria-hidden="true">
    <button type="button" class="close" id="closeBtn" aria-label="关闭">×</button>
    <h2 id="dTitle"></h2>
    <div class="vs-board">
      <div class="side">
        <div class="name" id="dSideA"></div>
        <div class="pct" id="dPriceA"></div>
      </div>
      <div class="mid">VS</div>
      <div class="side">
        <div class="name" id="dSideB"></div>
        <div class="pct" id="dPriceB"></div>
      </div>
    </div>
    <dl class="kv">
      <div><dt>状态</dt><dd id="dStatus"></dd></div>
      <div><dt>开赛</dt><dd id="dStart"></dd></div>
      <div><dt>Slug</dt><dd id="dSlug"></dd></div>
      <div><dt>URL</dt><dd id="dUrl"></dd></div>
    </dl>
    <div class="actions">
      <a class="btn primary" id="dOpen" href="#" target="_blank" rel="noopener">打开 Polymarket</a>
      <button type="button" class="btn ghost" id="dClose2">关闭</button>
    </div>
  </aside>

  <script id="boot" type="application/json">__DATA_JSON__</script>
  <script>
    const DATA = JSON.parse(document.getElementById('boot').textContent);
    let sport = 'nba';
    let selected = null;

    const listEl = document.getElementById('list');
    const metaEl = document.getElementById('meta');
    const qEl = document.getElementById('q');
    const drawer = document.getElementById('drawer');
    const mask = document.getElementById('mask');

    function pct(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      return (n * 100).toFixed(1) + '%';
    }
    function fmtStart(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return '—';
      try {
        return new Date(n).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
      } catch { return String(ms); }
    }
    function rows() {
      const all = DATA[sport] || [];
      const q = (qEl.value || '').trim().toLowerCase();
      if (!q) return all;
      return all.filter(r =>
        [r.title, r.sideA, r.sideB, r.slug].join(' ').toLowerCase().includes(q)
      );
    }
    function render() {
      const items = rows();
      metaEl.textContent = items.length + ' / ' + (DATA[sport] || []).length + ' 场';
      document.documentElement.style.setProperty('--accent', sport === 'nba' ? 'var(--nba)' : 'var(--dota)');
      if (!items.length) {
        listEl.innerHTML = '<div class="empty">没有匹配的赛事</div>';
        return;
      }
      listEl.innerHTML = items.map((r, i) => {
        const pa = Number(r.priceA);
        const hotA = Number.isFinite(pa) && pa >= 0.55;
        const hotB = Number.isFinite(Number(r.priceB)) && Number(r.priceB) >= 0.55;
        return `<button type="button" class="row" data-i="${i}">
          <div>
            <div class="title">${escapeHtml(r.title || r.slug)}
              <span class="badge ${r.closed ? 'closed' : 'open'}">${r.closed ? '已关闭' : '进行中'}</span>
            </div>
            <div class="sides">${escapeHtml(r.sideA || '?')} · ${escapeHtml(r.sideB || '?')}</div>
          </div>
          <div class="prices">
            <span class="pill ${hotA ? 'hot' : ''}">${pct(r.priceA)}</span>
            <span class="pill ${hotB ? 'hot' : ''}">${pct(r.priceB)}</span>
          </div>
        </button>`;
      }).join('');
      // map data-i to filtered index
      listEl.querySelectorAll('.row').forEach((btn, idx) => {
        btn.addEventListener('click', () => openDetail(items[idx]));
      });
    }
    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      })[c]);
    }
    function openDetail(r) {
      selected = r;
      document.getElementById('dTitle').textContent = r.title || r.slug || '详情';
      document.getElementById('dSideA').textContent = r.sideA || '—';
      document.getElementById('dSideB').textContent = r.sideB || '—';
      document.getElementById('dPriceA').textContent = pct(r.priceA);
      document.getElementById('dPriceB').textContent = pct(r.priceB);
      document.getElementById('dStatus').textContent = r.closed ? '已关闭' : '进行中 / 未关闭';
      document.getElementById('dStart').textContent = fmtStart(r.startMs);
      document.getElementById('dSlug').textContent = r.slug || '—';
      document.getElementById('dUrl').textContent = r.url || '—';
      const a = document.getElementById('dOpen');
      if (r.url) { a.href = r.url; a.style.opacity = '1'; a.style.pointerEvents = 'auto'; }
      else { a.href = '#'; a.style.opacity = '.4'; a.style.pointerEvents = 'none'; }
      drawer.classList.add('open');
      mask.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
    }
    function closeDetail() {
      drawer.classList.remove('open');
      mask.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        sport = tab.dataset.sport;
        document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t === tab ? 'true' : 'false'));
        render();
      });
    });
    qEl.addEventListener('input', render);
    mask.addEventListener('click', closeDetail);
    document.getElementById('closeBtn').addEventListener('click', closeDetail);
    document.getElementById('dClose2').addEventListener('click', closeDetail);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
    metaEl.title = 'fetched ' + (DATA.fetched_at || '');
    render();
  </script>
</body>
</html>
"""


def collect_one(
    sport: str,
    fetcher: Callable[..., list[dict[str, Any]]],
    *,
    day: str,
) -> list[dict[str, Any]]:
    print(f"[collect_polymarket_sports] fetching {sport}…", flush=True)
    try:
        items = fetcher(raise_on_total_failure=True)
    except Exception as exc:
        print(f"[collect_polymarket_sports] {sport} 失败: {exc}", flush=True)
        raise
    if not items:
        print(
            f"[collect_polymarket_sports] {sport} 返回 0 场（接口通但无事件，或过滤后为空）",
            flush=True,
        )
    path = write_sport_txt(sport, items, day=day)
    rows = [item_to_row(it) for it in items]
    print(f"[collect_polymarket_sports] {sport} → {path} ({len(rows)} 场)", flush=True)
    return rows


def build_html_from_txt(day: str) -> Path:
    nba = read_sport_txt(OUT_DIR / f"polymarket_nba_{day}.txt")
    dota = read_sport_txt(OUT_DIR / f"polymarket_dota_{day}.txt")
    path = write_sports_html(day=day, nba=nba, dota=dota)
    print(
        f"[collect_polymarket_sports] html → {path} (nba={len(nba)} dota={len(dota)})",
        flush=True,
    )
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Polymarket NBA/Dota → txt + html")
    parser.add_argument(
        "--sport",
        choices=("nba", "dota", "all"),
        default="all",
        help="采集范围（默认 all）",
    )
    parser.add_argument(
        "--html-only",
        action="store_true",
        help="不请求 API，用当日已有 txt 重建 html",
    )
    parser.add_argument(
        "--day",
        default=None,
        help="日期 YYYY-MM-DD（默认北京今天）",
    )
    args = parser.parse_args()
    day = args.day or _today_bj()

    if args.html_only:
        build_html_from_txt(day)
        return 0

    sports: list[tuple[str, Callable[..., list[dict[str, Any]]]]] = []
    if args.sport in ("nba", "all"):
        sports.append(("nba", fetch_polymarket_nba_events))
    if args.sport in ("dota", "all"):
        sports.append(("dota", fetch_polymarket_dota_events))

    failed = 0
    collected: dict[str, list[dict[str, Any]]] = {"nba": [], "dota": []}
    for name, fn in sports:
        try:
            collected[name] = collect_one(name, fn, day=day)
        except Exception:
            failed += 1

    # 单采时另一侧尽量从已有 txt 补齐，方便打开完整 html
    if args.sport != "all":
        other = "dota" if args.sport == "nba" else "nba"
        if not collected[other]:
            collected[other] = read_sport_txt(OUT_DIR / f"polymarket_{other}_{day}.txt")

    html_path = write_sports_html(
        day=day,
        nba=collected["nba"] or read_sport_txt(OUT_DIR / f"polymarket_nba_{day}.txt"),
        dota=collected["dota"] or read_sport_txt(OUT_DIR / f"polymarket_dota_{day}.txt"),
    )
    print(f"[collect_polymarket_sports] html → {html_path}", flush=True)

    if failed:
        print(f"[collect_polymarket_sports] 完成，失败 {failed}/{len(sports)}", flush=True)
        return 2
    print("[collect_polymarket_sports] 全部完成", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
