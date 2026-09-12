#!/usr/bin/env python3
"""Collect 2026 Grand Slam / Masters 1000 / 500 (+ US Open live) into docks/*.txt"""

from __future__ import annotations

import csv
import io
import re
import urllib.request
from collections import defaultdict
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent

ATP_URL = "https://cdn.jsdelivr.net/gh/Aneeshers/tennis-sackmann-archive@main/atp/atp_matches_2026.csv"
WTA_URL = "https://cdn.jsdelivr.net/gh/Aneeshers/tennis-sackmann-archive@main/wta/wta_matches_2026.csv"
CDN = "https://cdn.jsdelivr.net/gh/Aneeshers/tennis-sackmann-archive@main"

# Official 2026 ATP 500 (Sackmann tourney_name)
ATP_500_NAMES = {
    "Dallas",
    "Rotterdam",
    "Doha",
    "Rio de Janeiro",
    "Acapulco",
    "Dubai",
    "Barcelona",
    "Munich",
    "Hamburg",
    "Halle",
    "London",  # Queen's / HSBC Championships
    "Queen's Club",
    "Queens Club",
    "Washington",
    "Tokyo",
    "Beijing",
    "Basel",
    "Vienna",
}

# WTA: PM ~= 1000, P ~= 500 in Sackmann files
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read().decode("utf-8", errors="replace")


def norm(s: str | None) -> str:
    return (s or "").strip()


def match_line(tour: str, row: dict, peaks: dict[str, int] | None = None) -> str:
    date = norm(row.get("tourney_date"))
    round_ = norm(row.get("round"))
    surface = norm(row.get("surface"))
    tw = norm(row.get("winner_name"))
    tl = norm(row.get("loser_name"))
    score = norm(row.get("score"))
    wr = norm(row.get("winner_rank"))
    lr = norm(row.get("loser_rank"))
    wid = norm(row.get("winner_id"))
    lid = norm(row.get("loser_id"))
    peaks = peaks or {}
    wp = peaks.get(wid)
    lp = peaks.get(lid)
    wp_s = str(wp) if wp is not None else "-"
    lp_s = str(lp) if lp is not None else "-"
    if wp is not None and lp is not None:
        # 历史最高排位差 = |双方生涯最高排名之差|（数字越小排名越高）
        peak_diff = str(abs(wp - lp))
    else:
        peak_diff = "-"
    return (
        f"{date}\t{tour}\t{round_}\t{surface}\t"
        f"{tw} (rank {wr or '-'}, peak {wp_s})\tbt\t"
        f"{tl} (rank {lr or '-'}, peak {lp_s})\t{score}\t"
        f"peak_diff {peak_diff}"
    )


def load_career_peaks(tour: str, needed_ids: set[str]) -> dict[str, int]:
    """Min historical rank (career high) per player_id from ranking CSVs."""
    peaks: dict[str, int] = {}
    # Prefer recent decades; older decades if CDN allows
    suffixes = ["current", "20s", "10s", "00s", "90s"]
    for suf in suffixes:
        url = f"{CDN}/{tour}/{tour}_rankings_{suf}.csv"
        try:
            text = fetch(url)
        except Exception as e:
            print(f"  skip rankings {tour}_{suf}: {e}")
            continue
        print(f"  scanning {tour}_rankings_{suf}.csv …")
        for row in csv.DictReader(io.StringIO(text)):
            pid = norm(row.get("player"))
            if pid not in needed_ids:
                continue
            try:
                rk = int(row.get("rank") or 0)
            except ValueError:
                continue
            if rk <= 0:
                continue
            prev = peaks.get(pid)
            if prev is None or rk < prev:
                peaks[pid] = rk
    # Fallback: also mine ranks from 2026 matches themselves
    return peaks


def enrich_peaks_from_matches(rows: list[dict], peaks: dict[str, int]) -> None:
    for row in rows:
        for side in ("winner", "loser"):
            pid = norm(row.get(f"{side}_id"))
            try:
                rk = int(row.get(f"{side}_rank") or 0)
            except ValueError:
                continue
            if not pid or rk <= 0:
                continue
            prev = peaks.get(pid)
            if prev is None or rk < prev:
                peaks[pid] = rk


def build_name_peak_index(players_url: str, peaks: dict[str, int]) -> dict[str, int]:
    """Map 'Last' and 'First Last' lowercased names -> peak for TE name matching."""
    by_name: dict[str, int] = {}
    try:
        rows = load_csv(players_url)
    except Exception as e:
        print(f"  players file skip: {e}")
        return by_name
    for row in rows:
        pid = norm(row.get("player_id"))
        if pid not in peaks:
            continue
        first = norm(row.get("name_first"))
        last = norm(row.get("name_last"))
        full = f"{first} {last}".strip()
        peak = peaks[pid]
        for key in {last.lower(), full.lower(), f"{last} {first}".lower()}:
            if not key:
                continue
            # keep best (lowest) if collisions
            prev = by_name.get(key)
            if prev is None or peak < prev:
                by_name[key] = peak
    return by_name


def annotate_te_line(line: str, name_peaks: dict[str, int]) -> str:
    """Add peak / peak_diff onto TennisExplorer lines when names match."""
    if line.startswith("#") or "\tbt\t" not in line:
        return line
    try:
        left, right = line.split("\tbt\t", 1)
        w_m = re.search(r"\t([^\t]+)\s+\(rank [^)]*\)$", left)
        l_m = re.match(r"([^\t]+)\s+\(rank [^)]*\)\t(.*)$", right)
        if not w_m or not l_m:
            return line + "\tpeak_diff -"
        w_raw = w_m.group(1).strip()
        l_raw = l_m.group(1).strip()
        rest = l_m.group(2)
        w_name = re.sub(r"\s*\(\d+\)\s*$", "", w_raw).strip()
        l_name = re.sub(r"\s*\(\d+\)\s*$", "", l_raw).strip()

        def lookup(n: str) -> int | None:
            key = n.lower()
            if key in name_peaks:
                return name_peaks[key]
            parts = key.split()
            if parts and parts[-1] in name_peaks:
                return name_peaks[parts[-1]]
            if len(parts) >= 2 and parts[0] in name_peaks:
                return name_peaks[parts[0]]
            return None

        wp, lp = lookup(w_name), lookup(l_name)
        wp_s = str(wp) if wp is not None else "-"
        lp_s = str(lp) if lp is not None else "-"
        diff = str(abs(wp - lp)) if wp is not None and lp is not None else "-"
        prefix = left[: w_m.start(1)]
        return (
            f"{prefix}{w_raw} (rank -, peak {wp_s})\tbt\t"
            f"{l_raw} (rank -, peak {lp_s})\t{rest}\tpeak_diff {diff}"
        )
    except Exception:
        return line + "\tpeak_diff -"


def classify_atp(name: str, level: str) -> str | None:
    n, lv = norm(name), norm(level).upper()
    if lv == "G":
        return "grand_slam"
    if lv == "M":
        return "masters_1000"
    if lv == "A" and n in ATP_500_NAMES:
        return "atp_500"
    return None


def classify_wta(name: str, level: str) -> str | None:
    n, lv = norm(name), norm(level).upper()
    if lv == "G":
        return "grand_slam"
    if lv == "PM":
        return "wta_1000"
    if lv == "P":
        return "wta_500"
    return None


def _strip_html(s: str) -> str:
    s = re.sub(r"<sup>(.*?)</sup>", r"(\1)", s, flags=re.I | re.S)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", s).strip()


def _format_set(a: str, b: str) -> str:
    """Normalize TE set cells into 6-7(5) style."""
    ma = re.fullmatch(r"(\d+)\((\d+)\)", a)
    mb = re.fullmatch(r"(\d+)\((\d+)\)", b)
    if ma and not mb:
        return f"{ma.group(1)}-{b}({ma.group(2)})"
    if mb and not ma:
        return f"{a}-{mb.group(1)}({mb.group(2)})"
    return f"{a}-{b}"


def parse_tennisexplorer(html: str, tourney: str, tour: str) -> list[str]:
    """Parse TennisExplorer result tables (winner/loser row pairs with per-set scores)."""
    m = re.search(r'(<table[^>]*id="tournamentTable"[^>]*>.*?</table>)', html, re.I | re.S)
    chunk = m.group(1) if m else html

    trs = re.findall(r"<tr[^>]*>(.*?)</tr>", chunk, flags=re.I | re.S)
    lines: list[str] = []
    i = 0
    while i < len(trs) - 1:
        row = trs[i]
        if 'class="t-name"' not in row or 'class="score"' not in row:
            i += 1
            continue
        row2 = trs[i + 1]
        if 'class="t-name"' not in row2 or 'class="score"' not in row2:
            i += 1
            continue

        round_m = re.search(r'title="([^"]*)"[^>]*rowspan="2"[^>]*>([^<]*)</td>', row, re.I)
        round_ = round_m.group(2).strip() if round_m else "?"

        def player_and_scores(r: str) -> tuple[str, list[str], str]:
            nm = re.search(
                r'class="t-name"[^>]*>.*?href="[^"]+"[^>]*>([^<]+)</a>([^<]*)',
                r,
                re.I | re.S,
            )
            name = ""
            if nm:
                name = (nm.group(1) + nm.group(2)).strip()
            rm = re.search(r'class="result"[^>]*>(.*?)</td>', r, re.I | re.S)
            sets_won = _strip_html(rm.group(1)) if rm else ""
            sc = [
                _strip_html(x)
                for x in re.findall(r'class="score"[^>]*>(.*?)</td>', r, re.I | re.S)
            ]
            sc = [x for x in sc if x]
            return name, sc, sets_won

        w_name, w_sets, w_sw = player_and_scores(row)
        l_name, l_sets, l_sw = player_and_scores(row2)
        if not w_name or not l_name:
            i += 1
            continue

        # Ensure winner is first when sets-won is available
        if w_sw.isdigit() and l_sw.isdigit() and int(l_sw) > int(w_sw):
            w_name, l_name = l_name, w_name
            w_sets, l_sets = l_sets, w_sets

        n = max(len(w_sets), len(l_sets))
        parts = []
        for j in range(n):
            a = w_sets[j] if j < len(w_sets) else ""
            b = l_sets[j] if j < len(l_sets) else ""
            if not a and not b:
                continue
            parts.append(_format_set(a, b))
        score = " ".join(parts)

        lines.append(
            f"20260901\t{tourney}\t{round_}\tHard\t"
            f"{w_name} (rank -)\tbt\t{l_name} (rank -)\t{score}\t[{tour}]"
        )
        i += 2
    return lines


def scrape_us_open() -> list[str]:
    urls = [
        ("https://www.tennisexplorer.com/us-open/2026/atp-men/", "US Open", "ATP"),
        ("https://www.tennisexplorer.com/us-open/2026/wta-women/", "US Open", "WTA"),
    ]
    out: list[str] = []
    for url, tourney, tour in urls:
        try:
            html = fetch(url)
        except Exception as e:
            out.append(f"# ERROR fetching {url}: {e}")
            continue
        parsed = parse_tennisexplorer(html, tourney, tour)
        out.append(f"# source: {url} ({len(parsed)} matches parsed)")
        out.extend(parsed)
    return out


def load_csv(url: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(fetch(url))))


def write_txt(path: Path, header: str, lines: list[str]) -> None:
    body = "\n".join(lines)
    path.write_text(header + body + ("\n" if body else ""), encoding="utf-8")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    header = (
        "# year: 2026\n"
        "# levels: Grand Slam / Masters-WTA 1000 / ATP-WTA 500 (+ US Open supplement)\n"
        "# primary source: Jeff Sackmann archive mirror (CC BY-NC-SA 4.0)\n"
        "# columns: date\\ttournament\\tround\\tsurface\\twinner\\tbt\\tloser\\tscore\\tpeak_diff\n"
        "# rank = 当场排名; peak = 生涯历史最高排名; peak_diff = |双方peak之差|\n"
        "# note: Sackmann 2026 dump may lag live events (e.g. US Open); see us_open file\n"
        "#\n"
    )

    print("Fetching ATP/WTA 2026 CSVs…")
    atp = load_csv(ATP_URL)
    wta = load_csv(WTA_URL)
    print(f"  ATP {len(atp)}  WTA {len(wta)}")

    atp_ids: set[str] = set()
    wta_ids: set[str] = set()
    for row in atp:
        atp_ids.add(norm(row.get("winner_id")))
        atp_ids.add(norm(row.get("loser_id")))
    for row in wta:
        wta_ids.add(norm(row.get("winner_id")))
        wta_ids.add(norm(row.get("loser_id")))
    atp_ids.discard("")
    wta_ids.discard("")

    print("Building career-high peaks (ATP)…")
    atp_peaks = load_career_peaks("atp", atp_ids)
    enrich_peaks_from_matches(atp, atp_peaks)
    print(f"  ATP peaks: {len(atp_peaks)}/{len(atp_ids)}")
    print("Building career-high peaks (WTA)…")
    wta_peaks = load_career_peaks("wta", wta_ids)
    enrich_peaks_from_matches(wta, wta_peaks)
    print(f"  WTA peaks: {len(wta_peaks)}/{len(wta_ids)}")

    print("Building name→peak indexes for US Open scrape…")
    atp_name_peaks = build_name_peak_index(f"{CDN}/atp/atp_players.csv", atp_peaks)
    wta_name_peaks = build_name_peak_index(f"{CDN}/wta/wta_players.csv", wta_peaks)
    # merge last-name maps (WTA+ATP separate by tour tag later)
    te_name_peaks = {**atp_name_peaks, **wta_name_peaks}

    buckets: dict[str, list[str]] = defaultdict(list)
    index: dict[str, set[str]] = defaultdict(set)

    for row in atp:
        name, level = norm(row.get("tourney_name")), norm(row.get("tourney_level"))
        cat = classify_atp(name, level)
        if not cat:
            continue
        buckets[f"ATP_{cat}"].append(match_line(name, row, atp_peaks))
        index[f"ATP_{cat}"].add(f"{level}\t{name}")

    for row in wta:
        name, level = norm(row.get("tourney_name")), norm(row.get("tourney_level"))
        cat = classify_wta(name, level)
        if not cat:
            continue
        buckets[f"WTA_{cat}"].append(match_line(name, row, wta_peaks))
        index[f"WTA_{cat}"].add(f"{level}\t{name}")

    files = {
        "2026_grand_slam.txt": ["ATP_grand_slam", "WTA_grand_slam"],
        "2026_masters_1000.txt": ["ATP_masters_1000", "WTA_wta_1000"],
        "2026_500.txt": ["ATP_atp_500", "WTA_wta_500"],
        "2026_all_gs_1000_500.txt": [
            "ATP_grand_slam",
            "WTA_grand_slam",
            "ATP_masters_1000",
            "WTA_wta_1000",
            "ATP_atp_500",
            "WTA_wta_500",
        ],
    }

    us_sack = [
        ln
        for k in ("ATP_grand_slam", "WTA_grand_slam")
        for ln in buckets.get(k, [])
        if "US Open" in ln or "Us Open" in ln
    ]
    print("Scraping US Open from TennisExplorer…")
    us_live_raw = scrape_us_open()
    us_live = [annotate_te_line(ln, te_name_peaks) for ln in us_live_raw]
    us_match_lines = [ln for ln in us_live if not ln.startswith("#")]
    us_header = (
        "# US Open 2026\n"
        "# sackmann_rows + tennisexplorer supplement (live / in-progress)\n"
        "# rank=当场; peak=生涯最高; peak_diff=|双方peak差|\n"
        "#\n"
    )
    us_body = ["# --- from Sackmann archive ---"] + us_sack + ["", "# --- from TennisExplorer ---"] + us_live
    write_txt(OUT_DIR / "2026_us_open.txt", us_header, us_body)
    print(f"Wrote 2026_us_open.txt: sackmann={len(us_sack)} te_matches={len(us_match_lines)}")

    if us_match_lines and not us_sack:
        buckets["ATP_grand_slam"].extend(us_match_lines)

    for fname, keys in files.items():
        lines: list[str] = []
        for k in keys:
            lines.extend(buckets.get(k, []))
        lines.sort()
        write_txt(OUT_DIR / fname, header, lines)
        print(f"Wrote {fname}: {len(lines)} matches")

    idx = [
        "# Included tournaments by bucket\n",
        "# Coverage note: Sackmann 2026 archive currently has AO+RG (+ completed 1000/500).\n",
        "# Missing from archive so far: Wimbledon, US Open, late-season 1000/500.\n",
        "# US Open singles (through current round) appended from TennisExplorer into us_open + GS files.\n",
        "# peak / peak_diff from ranking history (career-high = min rank).\n",
    ]
    for k in sorted(index):
        idx.append(f"\n## {k}\n")
        for t in sorted(index[k]):
            idx.append(t + "\n")
    idx.append("\n## LIVE_US_Open_TennisExplorer\n")
    idx.append(f"matches\t{len(us_match_lines)}\n")
    (OUT_DIR / "2026_tournament_index.txt").write_text("".join(idx), encoding="utf-8")
    print("Done →", OUT_DIR)


if __name__ == "__main__":
    main()
