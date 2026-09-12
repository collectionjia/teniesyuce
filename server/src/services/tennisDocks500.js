/**
 * 将 docks/2026_500.txt 按 tourney_date 拆成按日 bundle，供「数据源 = docks500」回放。
 * 注意：Sackmann 的 date 多为赛事周起始日，同一天会含该站多轮次。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOCKS_ROOT = process.env.DOCKS_DIR
  ? path.resolve(process.env.DOCKS_DIR)
  : path.resolve(__dirname, '../../../docks');
const TXT_PATH = path.join(DOCKS_ROOT, '2026_500.txt');
/** 按日 JSON 可写目录（容器内默认 /tmp，避免 docks 只读挂载） */
const BY_DAY_DIR = process.env.DOCKS_BY_DAY_DIR
  ? path.resolve(process.env.DOCKS_BY_DAY_DIR)
  : path.join(DOCKS_ROOT, 'by_day_500');
const DATE_KEY = 'tennis:data_source:docks500_date';

const WTA_TOURNEYS = new Set([
  'Abu Dhabi',
  'Adelaide',
  'Brisbane',
  'Charleston',
  'Linz',
  'Merida',
  'Strasbourg',
  'Stuttgart',
]);

const ROUND_MAP = {
  R128: { name: 'Round of 128', round: 128 },
  R64: { name: 'Round of 64', round: 64 },
  R32: { name: 'Round of 32', round: 32 },
  R16: { name: 'Round of 16', round: 16 },
  QF: { name: 'Quarterfinals', round: 8 },
  SF: { name: 'Semifinals', round: 4 },
  F: { name: 'Final', round: 1 },
};

function stableId(parts) {
  const h = crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  // 正整数 id，避免与 Sofascore 撞车：用高位前缀
  return Number.parseInt(h.slice(0, 12), 16) % 2_000_000_000;
}

function parsePlayerCell(cell) {
  const s = String(cell || '').trim();
  const m = s.match(/^(.+?)\s*\(\s*rank\s*([^,)]*)\s*(?:,\s*peak\s*([^)]*))?\s*\)$/i);
  if (!m) {
    return { name: s || 'Unknown', rank: null, peak: null };
  }
  const name = m[1].trim();
  const rankRaw = String(m[2] || '').trim();
  const peakRaw = String(m[3] || '').trim();
  const rank = rankRaw && rankRaw !== '-' ? Number(rankRaw) : null;
  const peak = peakRaw && peakRaw !== '-' ? Number(peakRaw) : null;
  return {
    name,
    rank: Number.isFinite(rank) ? rank : null,
    peak: Number.isFinite(peak) ? peak : null,
  };
}

function parsePeakDiff(cell) {
  const m = String(cell || '').match(/peak_diff\s+(-?\d+|[-])/i);
  if (!m || m[1] === '-') return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function setsFromScore(score) {
  const parts = String(score || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let w = 0;
  let l = 0;
  for (const p of parts) {
    if (/ret/i.test(p) || /w\/o/i.test(p)) continue;
    const m = p.match(/^(\d+)(?:\(\d+\))?-(\d+)(?:\(\d+\))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > b) w += 1;
    else if (b > a) l += 1;
  }
  return { home: w, away: l };
}

function isoFromYmd(ymd) {
  const s = String(ymd || '');
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function ymdFromIso(iso) {
  return String(iso || '').replace(/-/g, '');
}

function parseTxt(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 8) continue;
    const [date, tournament, round, surface, winnerCell, , loserCell, score, peakCell] = cols;
    const iso = isoFromYmd(date);
    if (!iso) continue;
    const winner = parsePlayerCell(winnerCell);
    const loser = parsePlayerCell(loserCell);
    rows.push({
      ymd: date,
      iso,
      tournament: String(tournament || '').trim(),
      round: String(round || '').trim(),
      surface: String(surface || '').trim(),
      winner,
      loser,
      score: String(score || '').trim(),
      peakDiff: parsePeakDiff(peakCell || cols[cols.length - 1]),
    });
  }
  return rows;
}

function tourOf(tournament) {
  return WTA_TOURNEYS.has(tournament) ? 'WTA' : 'ATP';
}

function toEvent(row) {
  const tour = tourOf(row.tournament);
  const gender = tour === 'WTA' ? 'F' : 'M';
  const homeId = stableId(['p', tour, row.winner.name]);
  const awayId = stableId(['p', tour, row.loser.name]);
  const eventId = stableId(['e', row.iso, row.tournament, row.round, row.winner.name, row.loser.name]);
  const roundInfo = ROUND_MAP[row.round] || { name: row.round || null, round: null };
  const sets = setsFromScore(row.score);
  const home = {
    id: homeId,
    name: row.winner.name,
    shortName: row.winner.name,
    ranking: row.winner.rank,
    bestRank: row.winner.peak,
    best: row.winner.peak,
    gender,
  };
  const away = {
    id: awayId,
    name: row.loser.name,
    shortName: row.loser.name,
    ranking: row.loser.rank,
    bestRank: row.loser.peak,
    best: row.loser.peak,
    gender,
  };
  return {
    id: eventId,
    level: `${tour} 500`,
    tour,
    tennisPoints: 500,
    tournament: row.tournament,
    tournamentShort: row.tournament,
    status: 'Ended',
    statusType: 'ended',
    home: home.name,
    away: away.name,
    homePlayer: home,
    awayPlayer: away,
    homeScore: sets.home,
    awayScore: sets.away,
    scoreText: row.score,
    startTimestamp: Math.floor(new Date(`${row.iso}T12:00:00Z`).getTime() / 1000),
    roundInfo,
    roundLabel: row.round,
    groundType: row.surface,
    groundLabel: row.surface,
    gender,
    peakDiff: row.peakDiff,
    rankings: {
      [String(homeId)]: {
        current: row.winner.rank,
        best: row.winner.peak,
        previous: null,
        live: null,
        utr: null,
      },
      [String(awayId)]: {
        current: row.loser.rank,
        best: row.loser.peak,
        previous: null,
        live: null,
        utr: null,
      },
    },
  };
}

function groupTournaments(events) {
  const map = new Map();
  for (const ev of events) {
    const key = `${ev.tour}|${ev.tournament}`;
    if (!map.has(key)) {
      map.set(key, {
        name: ev.tournament,
        level: ev.level,
        tour: ev.tour,
        tennisPoints: 500,
        events: [],
      });
    }
    map.get(key).events.push(ev);
  }
  return [...map.values()].sort((a, b) =>
    String(a.tour).localeCompare(String(b.tour)) || String(a.name).localeCompare(String(b.name)),
  );
}

function strongNow(ev) {
  const a = Number(ev?.homePlayer?.ranking);
  const b = Number(ev?.awayPlayer?.ranking);
  const ranks = [a, b].filter((n) => Number.isFinite(n) && n > 0);
  return ranks.length ? Math.min(...ranks) : 999;
}

function parseSetPairs(score) {
  const out = [];
  for (const p of String(score || '').trim().split(/\s+/)) {
    const m = p.match(/^(\d+)(?:\(\d+\))?-(\d+)(?:\(\d+\))?$/);
    if (!m) continue;
    out.push({ home: Number(m[1]), away: Number(m[2]) });
  }
  return out;
}

function virtualOdds(ev) {
  const hr = Number(ev.homePlayer?.ranking) || 50;
  const ar = Number(ev.awayPlayer?.ranking) || 50;
  // 排名越好（数字小）赔率越低
  const homeEdge = Math.max(0.15, Math.min(0.85, 0.5 + (ar - hr) / 200));
  const homeDec = Math.round((1 / homeEdge) * 100) / 100;
  const awayDec = Math.round((1 / (1 - homeEdge)) * 100) / 100;
  return {
    eventId: ev.id,
    source: 'virtual-txt',
    full_time: { home: homeDec, away: awayDec, source: 'virtual-txt' },
  };
}

/** 把完赛场次改成赛前 / 赛中 / 盘后，便于虚拟联调 */
function applyVirtualPhases(bundle, opts = {}) {
  if (!bundle?.scheduled?.tournaments) return bundle;
  const now = Math.floor(Date.now() / 1000);
  const all = [];
  for (const t of bundle.scheduled.tournaments) {
    for (const e of t.events || []) all.push(e);
  }
  if (!all.length) return bundle;

  const n = all.length;
  const prematchCount = Number.isFinite(Number(opts.prematchCount))
    ? Math.max(0, Math.floor(Number(opts.prematchCount)))
    : Math.min(20, Math.max(10, Math.floor(n / 3)));
  const inplayCount = Number.isFinite(Number(opts.inplayCount))
    ? Math.max(0, Math.floor(Number(opts.inplayCount)))
    : Math.min(20, Math.max(10, Math.floor(n / 3)));

  // 优先：强者 Top100，且现差尽量大，方便条件组联调
  const ordered = [...all].sort((a, b) => {
    const ga = Math.abs((Number(a.homePlayer?.ranking) || 99) - (Number(a.awayPlayer?.ranking) || 99));
    const gb = Math.abs((Number(b.homePlayer?.ranking) || 99) - (Number(b.awayPlayer?.ranking) || 99));
    const sa = strongNow(a);
    const sb = strongNow(b);
    if (sa !== sb) return sa - sb;
    return gb - ga;
  });
  const preCandidates = ordered.filter((e) => {
    const h = Number(e.homePlayer?.ranking);
    const a = Number(e.awayPlayer?.ranking);
    if (!Number.isFinite(h) || !Number.isFinite(a)) return false;
    return Math.abs(h - a) >= 15 && Math.min(h, a) <= 100;
  });
  const prePool = (preCandidates.length >= prematchCount ? preCandidates : ordered)
    .slice(0, Math.min(prematchCount, n));
  const preIds = new Set(prePool.map((e) => String(e.id)));
  const remain = ordered.filter((e) => !preIds.has(String(e.id)));
  const inPool = remain.slice(0, Math.min(inplayCount, remain.length));
  const inIds = new Set(inPool.map((e) => String(e.id)));

  const oddsByEvent = { ...(bundle.oddsByEvent || {}) };
  const polymarketByEvent = { ...(bundle.polymarketByEvent || {}) };
  const liveMatches = [];

  for (const ev of all) {
    const id = String(ev.id);
    const finalScore = ev.scoreText || ev.finalScoreText || '';
    const pairs = parseSetPairs(finalScore);
    oddsByEvent[id] = virtualOdds(ev);

    // 约一半场次挂假 PM 外链，便于条件「有外链」联调
    if (Math.abs(Number(ev.id) % 2) === 0) {
      const homeStrong = strongNow(ev) === Number(ev.homePlayer?.ranking);
      polymarketByEvent[id] = {
        url: `https://polymarket.com/event/virtual-${id}`,
        slug: `virtual-${id}`,
        moneyline: {
          prices: {
            home: homeStrong ? 0.62 : 0.38,
            away: homeStrong ? 0.38 : 0.62,
          },
        },
        prices: {
          home: homeStrong ? 62 : 38,
          away: homeStrong ? 38 : 62,
        },
        source: 'virtual-txt',
      };
      ev.polymarketUrl = polymarketByEvent[id].url;
    }

    if (preIds.has(id)) {
      ev.status = 'Not started';
      ev.statusType = 'notstarted';
      ev.homeScore = null;
      ev.awayScore = null;
      ev.scoreText = '';
      ev.finalScoreText = finalScore;
      ev.virtualPhase = 'prematch';
      // 2～8 小时后开赛，避免立刻被 startTime 迁盘中
      ev.startTimestamp = now + 7200 + (Math.abs(Number(ev.id) % 6) * 3600);
      continue;
    }

    if (inIds.has(id)) {
      ev.status = 'In progress';
      ev.statusType = 'inprogress';
      ev.virtualPhase = 'inplay';
      ev.finalScoreText = finalScore;
      ev.startTimestamp = now - 1800 - (Math.abs(Number(ev.id) % 4) * 600);
      if (pairs.length >= 2) {
        // 模拟盘中：首盘已完 + 次盘进行中（保留真实首盘局分，便于「排除 7:5」联调）
        const s1 = pairs[0];
        const homeSets = s1.home > s1.away ? 1 : 0;
        const awaySets = s1.away > s1.home ? 1 : 0;
        let curHome = Number(pairs[1].home);
        let curAway = Number(pairs[1].away);
        if (!Number.isFinite(curHome) || !Number.isFinite(curAway)) {
          curHome = 3;
          curAway = 2;
        }
        // 未完成盘：压到 0–5，避免被当成完赛盘
        curHome = Math.max(0, Math.min(5, curHome));
        curAway = Math.max(0, Math.min(5, curAway));
        if (curHome === curAway) curAway = Math.max(0, curHome - 1);
        ev.scoreText = `${s1.home}-${s1.away} ${curHome}-${curAway}`;
        ev.homeScore = {
          current: homeSets,
          display: homeSets,
          period1: s1.home,
          period2: curHome,
          point: '30',
        };
        ev.awayScore = {
          current: awaySets,
          display: awaySets,
          period1: s1.away,
          period2: curAway,
          point: '15',
        };
      } else if (pairs.length === 1) {
        const s1 = pairs[0];
        // 首盘进行中：用真实局分压一档，模拟未完
        let curHome = Math.min(5, Math.max(0, s1.home));
        let curAway = Math.min(5, Math.max(0, s1.away));
        if (curHome >= 6 || curAway >= 6) {
          curHome = Math.min(5, curHome);
          curAway = Math.min(4, curAway);
        }
        ev.scoreText = `${curHome}-${curAway}`;
        ev.homeScore = { current: 0, display: 0, period1: curHome, point: '40' };
        ev.awayScore = { current: 0, display: 0, period1: curAway, point: '30' };
      } else {
        ev.scoreText = '3-2';
        ev.homeScore = { current: 0, display: 0, period1: 3, point: '15' };
        ev.awayScore = { current: 0, display: 0, period1: 2, point: '30' };
      }
      liveMatches.push(ev);
      continue;
    }

    // 其余保持完赛
    ev.status = 'Ended';
    ev.statusType = 'ended';
    ev.virtualPhase = 'settled';
    ev.scoreText = finalScore || ev.scoreText;
    ev.finalScoreText = finalScore || ev.finalScoreText;
    ev.startTimestamp = now - 86400 - (Math.abs(Number(ev.id) % 12) * 3600);
  }

  const tournaments = groupTournaments(all);
  const liveGroup = groupTournaments(liveMatches);
  bundle.scheduled = {
    tournaments,
    tournamentCount: tournaments.length,
    eventCount: all.length,
  };
  bundle.live = {
    tournaments: liveGroup,
    matches: liveMatches,
    tournamentCount: liveGroup.length,
    eventCount: liveMatches.length,
  };
  bundle.oddsByEvent = oddsByEvent;
  bundle.polymarketByEvent = polymarketByEvent;
  bundle.rankingsByPlayer = buildRankings(all);
  bundle.virtualSim = {
    prematch: preIds.size,
    inplay: inIds.size,
    settled: Math.max(0, all.length - preIds.size - inIds.size),
    prematchIds: [...preIds],
    inplayIds: [...inIds],
  };
  bundle.update = {
    message: `虚拟模拟 · 盘前${preIds.size} · 盘中${inIds.size} · 盘后${bundle.virtualSim.settled}`,
    at: new Date().toISOString(),
  };
  bundle.message = bundle.update.message;
  bundle.exclude_ended = false;
  return bundle;
}

function buildRankings(events) {
  const map = {};
  for (const ev of events) {
    for (const [pid, row] of Object.entries(ev.rankings || {})) {
      map[pid] = { ...(map[pid] || {}), ...row };
    }
  }
  return map;
}

function buildBundleForRows(iso, rows) {
  const events = rows.map(toEvent);
  const tournaments = groupTournaments(events);
  const rankingsByPlayer = buildRankings(events);
  const eventCount = events.length;
  return {
    sport: 'tennis',
    date: iso,
    fetched_at: new Date().toISOString(),
    source: 'docks500',
    upstream: 'docks500',
    dataSource: 'docks500',
    filter: 'atp-wta-500-replay',
    top_rank_max: 999,
    exclude_ended: false,
    update: {
      message: `docks/2026_500 · ${iso} · ${eventCount} 场`,
      at: new Date().toISOString(),
    },
    scheduled: {
      tournaments,
      tournamentCount: tournaments.length,
      eventCount,
    },
    live: {
      tournaments: [],
      matches: [],
      tournamentCount: 0,
      eventCount: 0,
    },
    // 盘后页读取 settled；同时把完赛场挂到 settled 形状
    settled: {
      tournaments,
      tournamentCount: tournaments.length,
      eventCount,
      matches: events,
    },
    rankingsByPlayer,
    oddsByEvent: {},
    eloByEvent: {},
    polymarketByEvent: {},
    theOddsApiByEvent: {},
    birthYearByPlayer: {},
    ok: true,
    member: true,
    events: eventCount,
    message: `docks500 · ${iso} · ${eventCount} events`,
  };
}

function ensureParsed() {
  if (!fs.existsSync(TXT_PATH)) {
    throw Object.assign(new Error(`找不到 ${TXT_PATH}`), { status: 404 });
  }
  const text = fs.readFileSync(TXT_PATH, 'utf8');
  return parseTxt(text);
}

function splitByDay(rows = null) {
  const all = rows || ensureParsed();
  const byDay = new Map();
  for (const row of all) {
    if (!byDay.has(row.iso)) byDay.set(row.iso, []);
    byDay.get(row.iso).push(row);
  }
  fs.mkdirSync(BY_DAY_DIR, { recursive: true });
  const days = [];
  for (const [iso, dayRows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bundle = buildBundleForRows(iso, dayRows);
    const tours = [...new Set(dayRows.map((r) => r.tournament))].sort();
    const meta = {
      date: iso,
      ymd: ymdFromIso(iso),
      matchCount: dayRows.length,
      tournaments: tours,
    };
    const outPath = path.join(BY_DAY_DIR, `${iso}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ meta, bundle }, null, 2), 'utf8');
    // 另存可读 txt
    const txtLines = [
      `# ${iso} · ${dayRows.length} matches · ${tours.join(', ')}`,
      ...dayRows.map(
        (r) =>
          `${r.iso}\t${r.tournament}\t${r.round}\t${r.surface}\t${r.winner.name}\tbt\t${r.loser.name}\t${r.score}\tpeak_diff ${r.peakDiff ?? '-'}`,
      ),
    ];
    fs.writeFileSync(path.join(BY_DAY_DIR, `${iso}.txt`), `${txtLines.join('\n')}\n`, 'utf8');
    days.push(meta);
  }
  fs.writeFileSync(path.join(BY_DAY_DIR, 'index.json'), JSON.stringify({ days, generated_at: new Date().toISOString() }, null, 2), 'utf8');
  return { days, dir: BY_DAY_DIR, total: all.length };
}

function listDays() {
  const indexPath = path.join(BY_DAY_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) {
    // 若本地仓库已有 by_day（只读挂载旁的缓存目录为空），先尝试从 DOCKS_ROOT 拷贝索引
    const repoIndex = path.join(DOCKS_ROOT, 'by_day_500', 'index.json');
    if (fs.existsSync(repoIndex) && path.resolve(repoIndex) !== path.resolve(indexPath)) {
      try {
        fs.mkdirSync(BY_DAY_DIR, { recursive: true });
        fs.copyFileSync(repoIndex, indexPath);
        for (const name of fs.readdirSync(path.join(DOCKS_ROOT, 'by_day_500'))) {
          if (!name.endsWith('.json') && !name.endsWith('.txt')) continue;
          const src = path.join(DOCKS_ROOT, 'by_day_500', name);
          const dst = path.join(BY_DAY_DIR, name);
          if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  if (!fs.existsSync(indexPath)) {
    return splitByDay().days;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(raw.days) ? raw.days : [];
  } catch {
    return splitByDay().days;
  }
}

function pickSourceDays(preferDates = []) {
  const days = listDays().filter((d) => d?.date && d.date !== 'index');
  if (!days.length) {
    splitByDay();
  }
  const all = listDays().slice();
  const preferred = [];
  for (const d of preferDates) {
    const hit = all.find((x) => x.date === d);
    if (hit) preferred.push(hit);
  }
  const rest = all
    .filter((d) => !preferred.some((p) => p.date === d.date))
    .sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));
  return [...preferred, ...rest];
}

function remapSimEvent(ev, targetIso, idx) {
  const oldId = String(ev.id);
  const newId = stableId(['simday', targetIso, oldId, idx]);
  const next = JSON.parse(JSON.stringify(ev));
  next.id = newId;
  next.simFromId = oldId;
  next.simDate = targetIso;
  // 重写球员 id，避免多日合并撞车
  if (next.homePlayer) {
    const hid = stableId(['simp', targetIso, next.homePlayer.name || next.home, 'H']);
    next.homePlayer = { ...next.homePlayer, id: hid };
  }
  if (next.awayPlayer) {
    const aid = stableId(['simp', targetIso, next.awayPlayer.name || next.away, 'A']);
    next.awayPlayer = { ...next.awayPlayer, id: aid };
  }
  const rankings = {};
  if (next.homePlayer?.id != null) {
    rankings[String(next.homePlayer.id)] = {
      current: next.homePlayer.ranking ?? null,
      best: next.homePlayer.bestRank ?? next.homePlayer.best ?? null,
      previous: null,
      live: null,
      utr: null,
    };
  }
  if (next.awayPlayer?.id != null) {
    rankings[String(next.awayPlayer.id)] = {
      current: next.awayPlayer.ranking ?? null,
      best: next.awayPlayer.bestRank ?? next.awayPlayer.best ?? null,
      previous: null,
      live: null,
      utr: null,
    };
  }
  next.rankings = rankings;
  next.status = 'Ended';
  next.statusType = 'ended';
  return next;
}

/**
 * 从历史 txt 日包克隆，合成「目标日」赛程（用于今天联调；Sackmann 无该日真实场次时）。
 */
function synthesizeDay(targetIso, {
  preferDates = ['2026-04-13', '2026-02-09', '2026-05-17', '2026-01-04'],
  targetCount = 60,
} = {}) {
  const date = String(targetIso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('日期格式应为 YYYY-MM-DD'), { status: 400 });
  }
  fs.mkdirSync(BY_DAY_DIR, { recursive: true });
  const outPath = path.join(BY_DAY_DIR, `${date}.json`);
  if (fs.existsSync(outPath)) {
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }

  const sources = pickSourceDays(preferDates);
  if (!sources.length) {
    throw Object.assign(new Error('没有可用于克隆的历史日包'), { status: 404 });
  }

  const collected = [];
  const seenPair = new Set();
  for (const src of sources) {
    const srcPath = path.join(BY_DAY_DIR, `${src.date}.json`);
    const repoSrc = path.join(DOCKS_ROOT, 'by_day_500', `${src.date}.json`);
    const pathToRead = fs.existsSync(srcPath) ? srcPath : repoSrc;
    if (!fs.existsSync(pathToRead)) continue;
    const raw = JSON.parse(fs.readFileSync(pathToRead, 'utf8'));
    const bundle = raw.bundle || raw;
    const events = [];
    for (const t of bundle.scheduled?.tournaments || []) {
      for (const e of t.events || []) events.push(e);
    }
    // 优先大现差 + Top100
    events.sort((a, b) => {
      const ga = Math.abs((Number(a.homePlayer?.ranking) || 99) - (Number(a.awayPlayer?.ranking) || 99));
      const gb = Math.abs((Number(b.homePlayer?.ranking) || 99) - (Number(b.awayPlayer?.ranking) || 99));
      return gb - ga || strongNow(a) - strongNow(b);
    });
    for (const e of events) {
      const pair = `${e.home || e.homePlayer?.name}|${e.away || e.awayPlayer?.name}`;
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
      collected.push(remapSimEvent(e, date, collected.length));
      if (collected.length >= targetCount) break;
    }
    if (collected.length >= targetCount) break;
  }

  if (!collected.length) {
    throw Object.assign(new Error('克隆历史场次失败'), { status: 500 });
  }

  const tournaments = groupTournaments(collected);
  const rankingsByPlayer = buildRankings(collected);
  const bundle = {
    sport: 'tennis',
    date,
    fetched_at: new Date().toISOString(),
    source: 'docks500',
    upstream: 'docks500',
    dataSource: 'docks500',
    filter: 'sim-today-from-txt',
    top_rank_max: 999,
    exclude_ended: false,
    update: {
      message: `虚拟今天 ${date} · 自 txt 克隆 ${collected.length} 场`,
      at: new Date().toISOString(),
    },
    scheduled: {
      tournaments,
      tournamentCount: tournaments.length,
      eventCount: collected.length,
    },
    live: { tournaments: [], matches: [], tournamentCount: 0, eventCount: 0 },
    settled: {
      tournaments,
      tournamentCount: tournaments.length,
      eventCount: collected.length,
      matches: collected,
    },
    rankingsByPlayer,
    oddsByEvent: {},
    eloByEvent: {},
    polymarketByEvent: {},
    theOddsApiByEvent: {},
    birthYearByPlayer: {},
    ok: true,
    member: true,
    events: collected.length,
    message: `sim-today · ${date} · ${collected.length} events`,
    synthetic: true,
    syntheticFrom: sources.slice(0, 3).map((s) => s.date),
  };

  const tours = [...new Set(collected.map((e) => e.tournament).filter(Boolean))].sort();
  const meta = {
    date,
    ymd: ymdFromIso(date),
    matchCount: collected.length,
    tournaments: tours,
    synthetic: true,
  };
  const payload = { meta, bundle };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(BY_DAY_DIR, `${date}.txt`),
    [
      `# ${date} · synthetic today · ${collected.length} matches · from ${meta.tournaments.join(', ')}`,
      ...collected.map(
        (e) =>
          `${date}\t${e.tournament || '-'}\t${e.roundLabel || '-'}\t${e.groundType || '-'}\t${e.home}\tbt\t${e.away}\t${e.scoreText || e.finalScoreText || '-'}\tsim`,
      ),
    ].join('\n') + '\n',
    'utf8',
  );

  // 更新 index
  const indexPath = path.join(BY_DAY_DIR, 'index.json');
  let days = listDays().filter((d) => d.date !== date);
  days.push(meta);
  days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  fs.writeFileSync(indexPath, JSON.stringify({ days, generated_at: new Date().toISOString() }, null, 2), 'utf8');
  return payload;
}

function loadDayBundle(iso, { simulate = true } = {}) {
  const date = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('日期格式应为 YYYY-MM-DD'), { status: 400 });
  }
  const jsonPath = path.join(BY_DAY_DIR, `${date}.json`);
  if (!fs.existsSync(jsonPath)) {
    // 先尝试从仓库 by_day 拷贝
    const repoPath = path.join(DOCKS_ROOT, 'by_day_500', `${date}.json`);
    if (fs.existsSync(repoPath)) {
      fs.mkdirSync(BY_DAY_DIR, { recursive: true });
      fs.copyFileSync(repoPath, jsonPath);
    } else {
      // 无真实日包时：用历史 txt 克隆成「目标日」虚拟赛程
      synthesizeDay(date);
    }
  }
  if (!fs.existsSync(jsonPath)) {
    throw Object.assign(new Error(`没有 ${date} 的赛程数据`), { status: 404 });
  }
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const bundle = raw.bundle || raw;
  if (simulate) applyVirtualPhases(bundle);
  return bundle;
}

async function loadSelectedBundle() {
  let date = await getSelectedDate();
  const days = listDays();
  if (!date && days.length) date = days[0].date;
  if (!date) throw Object.assign(new Error('docks500 无可用日期'), { status: 404 });
  const bundle = loadDayBundle(date, { simulate: true });
  bundle.date = date;
  bundle.dataSource = 'docks500';
  bundle.upstream = 'docks500';
  bundle.source = 'docks500';
  return bundle;
}

async function getSelectedDate() {
  const redis = require('./redis');
  const client = await redis.getClient();
  if (!client) {
    const days = listDays();
    return days[0]?.date || null;
  }
  try {
    const v = await client.get(DATE_KEY);
    if (v) return v;
  } catch (_) {
    /* ignore */
  }
  const days = listDays();
  return days[0]?.date || null;
}

async function setSelectedDate(iso) {
  const date = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('日期格式应为 YYYY-MM-DD'), { status: 400 });
  }
  // 校验存在（不跑模拟，避免重复写状态）
  loadDayBundle(date, { simulate: false });
  const redis = require('./redis');
  const client = await redis.getClient();
  if (client) {
    await client.set(DATE_KEY, date);
  }
  return date;
}

module.exports = {
  TXT_PATH,
  BY_DAY_DIR,
  DATE_KEY,
  parseTxt,
  splitByDay,
  listDays,
  loadDayBundle,
  getSelectedDate,
  setSelectedDate,
  loadSelectedBundle,
  applyVirtualPhases,
  synthesizeDay,
};
