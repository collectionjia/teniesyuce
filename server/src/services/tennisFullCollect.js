/**
 * Top100 全量采集（原 collect.py）：IPWO → Sofascore → Polymarket → 只写 Redis tennis:bundle:full
 */
const fs = require('fs');
const path = require('path');
const tennisCache = require('./tennisCache');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisEngines = require('./tennisEngines');
const { sofaApiGet, eventScore, fetchLiveTennisEvents } = require('./tennisSofascore');
const { applyPolymarketLinks } = require('./tennisPolymarketMatch');

const TOP_N = Math.max(1, Number(process.env.SOFA_TOP_N || 100));
const LIVE_TYPES = new Set(['inprogress', 'live', 'interrupted']);
const ENDED_TYPES = new Set(['finished', 'canceled', 'cancelled', 'ended']);
const BJ_OFFSET_MS = 8 * 3600 * 1000;
const STEPS = 6;

function todayBj() {
  const d = new Date(Date.now() + BJ_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

function shiftDate(matchDate, days) {
  const base = new Date(`${matchDate}T00:00:00+08:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function collectDateList(startDate, horizonDays) {
  const n = Math.max(1, Number(horizonDays) || 1);
  return Array.from({ length: n }, (_, i) => shiftDate(startDate, i));
}

function readHorizonDays() {
  const allowed = new Set([1, 2, 3, 5]);
  try {
    const monitorDir =
      process.env.TENNIS_MONITOR_DIR ||
      path.join(__dirname, '../../../scripts/tennis-monitor');
    const file = path.join(monitorDir, 'config', 'schedule.json');
    if (!fs.existsSync(file)) return 1;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const n = Number(data.collect_horizon_days || 1);
    return allowed.has(n) ? n : 1;
  } catch {
    return 1;
  }
}

function formatDuration(sec) {
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m${(sec % 60).toFixed(1)}s`;
}

function normName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function nameKeys(name) {
  const base = normName(name);
  if (!base) return [];
  const keys = [base];
  const parts = base.split(/\s+/);
  if (parts.length) keys.push(parts[parts.length - 1]);
  if (parts.length >= 2) keys.push(`${parts[parts.length - 1]} ${parts[0][0] || ''}`);
  return keys;
}

function playerSide(ev, side) {
  const team = ev[`${side}Team`] || ev[side] || {};
  if (typeof team === 'string') return { id: null, name: team, rank: null };
  const country = team.country;
  return {
    id: team.id,
    name: team.name || team.shortName,
    shortName: team.shortName,
    rank: team.ranking || team.rank,
    gender: team.gender,
    country: typeof country === 'object' ? country?.name : country,
  };
}

function eventTour(ev) {
  const unique = ev.uniqueTournament || ev.tournament?.uniqueTournament || {};
  const cat = String(unique.category?.slug || unique.category?.name || '').toLowerCase();
  if (cat.includes('wta')) return 'WTA';
  if (cat.includes('atp') || cat.includes('challenger')) return 'ATP';
  const home = playerSide(ev, 'home');
  if (home.gender === 'F') return 'WTA';
  if (home.gender === 'M') return 'ATP';
  return String(ev.tour || 'ATP').toUpperCase();
}

function tourLevelLabel(ev, tour) {
  const unique = ev.uniqueTournament || ev.tournament?.uniqueTournament || {};
  const name = String(unique.name || unique.slug || '').toLowerCase();
  const tier = String(unique.category || '').toLowerCase();
  const points = unique.tennisPoints ?? unique.userCount;
  const prefix = (tour || eventTour(ev) || 'ATP').toUpperCase();
  if (
    ['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((x) =>
      name.includes(x),
    ) ||
    tier.includes('grand_slam') ||
    tier.includes('grand slam')
  ) {
    return `${prefix} GS`;
  }
  const p = Number(points);
  if (Number.isFinite(p)) {
    if (p >= 1000) return `${prefix} 1000`;
    if (p >= 500) return `${prefix} 500`;
    if (p >= 250) return `${prefix} 250`;
  }
  if (name.includes('1000') || name.includes('masters')) return `${prefix} 1000`;
  if (name.includes('500')) return `${prefix} 500`;
  if (name.includes('250')) return `${prefix} 250`;
  return prefix;
}

function roundLabel(info) {
  if (!info || typeof info !== 'object') return null;
  for (const key of ['name', 'round', 'description']) {
    if (info[key]) return String(info[key]);
  }
  if (info.cupRoundType != null) return String(info.cupRoundType);
  return null;
}

const PHASE_LABEL = { not_started: '未开赛', live: '进行中', ended: '已结束' };

function phaseOf(ev) {
  if (isEnded(ev)) return 'ended';
  if (isLive(ev)) return 'live';
  return 'not_started';
}

function applyPhaseMark(ev) {
  const phase = phaseOf(ev);
  ev.phaseMark = phase;
  ev.phaseLabel = PHASE_LABEL[phase];
  return ev;
}

function slimEvent(ev) {
  const home = playerSide(ev, 'home');
  const away = playerSide(ev, 'away');
  const status = typeof ev.status === 'object' ? ev.status : {};
  const tournament = ev.tournament || {};
  const unique = ev.uniqueTournament || tournament.uniqueTournament || {};
  const tour = eventTour(ev);
  const ts = ev.startTimestamp;
  let startTime = null;
  if (ts) {
    startTime = new Date(Number(ts) * 1000 + BJ_OFFSET_MS).toISOString().slice(11, 16);
  }
  const eid = ev.id;
  const slug = ev.slug;
  return applyPhaseMark({
    id: eid,
    level: tourLevelLabel(ev, tour),
    tour,
    home: home.name,
    away: away.name,
    homePlayer: home,
    awayPlayer: away,
    status: status.description || ev.status,
    statusType: status.type || ev.statusType,
    homeScore: ev.homeScore,
    awayScore: ev.awayScore,
    home_score: typeof ev.homeScore === 'object' ? ev.homeScore?.current : ev.homeScore,
    away_score: typeof ev.awayScore === 'object' ? ev.awayScore?.current : ev.awayScore,
    scoreText: eventScore(ev),
    tournament: unique.name || tournament.name,
    tournamentShort: tournament.name || unique.name,
    roundInfo: ev.roundInfo,
    roundLabel: roundLabel(ev.roundInfo),
    groundType: ev.groundType || unique.groundType,
    startTimestamp: ts,
    startTime,
    slug,
    customId: ev.customId,
    url: slug
      ? `https://www.sofascore.com/event/tennis/${slug}`
      : eid != null
        ? `https://www.sofascore.com/event/tennis/${eid}`
        : null,
  });
}

function isEnded(ev) {
  const st = typeof ev.status === 'object' ? ev.status : {};
  const typ = String(st.type || ev.statusType || '').toLowerCase();
  const desc = String(st.description || ev.status || '').toLowerCase();
  if (ENDED_TYPES.has(typ)) return true;
  return ['ended', 'finished', 'retired', 'walkover', 'cancel'].some((k) => desc.includes(k));
}

function isLive(ev) {
  const st = typeof ev.status === 'object' ? ev.status : {};
  const typ = String(st.type || ev.statusType || '').toLowerCase();
  const desc = String(st.description || '').toLowerCase();
  return LIVE_TYPES.has(typ) || desc.includes('live');
}

function eventLocalDate(ev) {
  const ts = ev.startTimestamp;
  if (!ts) return null;
  return new Date(Number(ts) * 1000 + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

function isTierEvent(ev) {
  const label = tourLevelLabel(ev, eventTour(ev));
  return label.endsWith(' GS') || label.endsWith(' 1000') || label.endsWith(' 500');
}

function isTierTournament(tournament) {
  const unique = tournament.uniqueTournament || {};
  const cat = String(unique.category?.slug || '').toLowerCase();
  if (!['atp', 'wta'].includes(cat)) return false;
  const tour = cat.includes('wta') ? 'WTA' : 'ATP';
  const label = tourLevelLabel({ uniqueTournament: unique, tournament }, tour);
  return label.endsWith(' GS') || label.endsWith(' 1000') || label.endsWith(' 500');
}

function groupScheduled(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = ev.tournament || ev.tournamentShort || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const tournaments = [...groups.entries()].map(([name, items]) => ({ name, events: items }));
  return {
    tournaments,
    tournamentCount: tournaments.length,
    eventCount: events.length,
  };
}

async function fetchRankBoard(topN = TOP_N) {
  const board = { atp: [], wta: [], player_ids: new Set(), name_keys: new Set() };
  for (const [tour, apiPath] of [
    ['atp', 'rankings/type/7'],
    ['wta', 'rankings/type/6'],
  ]) {
    const data = await sofaApiGet(apiPath);
    const rows = data.rankings || data.list || [];
    const players = [];
    for (const row of rows.slice(0, topN)) {
      const team = row.team || row.player || {};
      const pid = team.id || row.id;
      const name = team.name || row.name;
      if (pid != null) board.player_ids.add(Number(pid));
      for (const key of nameKeys(name)) board.name_keys.add(key);
      players.push({
        id: pid,
        rank: row.ranking || row.rank,
        previousRank: row.previousRanking || row.previousRank,
        bestRank: row.bestRanking || row.bestRank || team.bestRanking,
        name,
        country: typeof team.country === 'object' ? team.country?.name : team.country,
        points: row.points || row.rowPoints,
        matches: [],
        matchCount: 0,
      });
    }
    board[tour] = players;
  }
  return board;
}

function eventMatchesBoard(ev, board) {
  for (const side of ['home', 'away']) {
    const p = playerSide(ev, side);
    if (p.id != null && board.player_ids.has(Number(p.id))) return true;
    for (const key of nameKeys(p.name)) {
      if (board.name_keys.has(key)) return true;
    }
  }
  return false;
}

function rankingsFromBoard(board) {
  const out = {};
  for (const tour of ['atp', 'wta']) {
    for (const p of board[tour] || []) {
      if (p.id == null) continue;
      out[String(p.id)] = {
        current: p.rank,
        previous: p.previousRank,
        best: p.bestRank,
        live: p.liveRank,
        utr: p.utr,
      };
    }
  }
  return out;
}

function attachBoardMatches(board, events) {
  for (const ev of events) {
    for (const side of ['home', 'away']) {
      const p = playerSide(ev, side);
      const tour = eventTour(ev) === 'WTA' ? 'wta' : 'atp';
      const list = board[tour] || [];
      const hit = list.find(
        (row) =>
          (p.id != null && row.id === p.id) ||
          (p.name && normName(row.name) === normName(p.name)),
      );
      if (!hit) continue;
      hit.matches = hit.matches || [];
      hit.matches.push({ id: ev.id, home: ev.home, away: ev.away });
      hit.matchCount = hit.matches.length;
    }
  }
}

async function listScheduledTournaments(matchDate) {
  const tournaments = [];
  const seen = new Set();
  let pages = 0;
  for (let page = 1; page <= 10; page += 1) {
    const data = await sofaApiGet(`sport/tennis/scheduled-tournaments/${matchDate}/page/${page}`);
    pages += 1;
    for (const group of data.scheduled || []) {
      const tournament = group.tournament || {};
      const tid = tournament.id;
      if (tid == null || seen.has(tid)) continue;
      seen.add(tid);
      tournaments.push(tournament);
    }
    if (!data.hasNextPage) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { tournaments, pages };
}

async function fetchTournamentEvents(tournament) {
  const unique = tournament.uniqueTournament || {};
  const uid = unique.id;
  const tid = tournament.id;
  if (!uid || !tid) return [];
  const seasons = await sofaApiGet(`unique-tournament/${uid}/seasons`);
  const seasonList = seasons.seasons || [];
  if (!seasonList.length) return [];
  await new Promise((r) => setTimeout(r, 500));
  const evdata = await sofaApiGet(`tournament/${tid}/season/${seasonList[0].id}/events`);
  return evdata.events || [];
}

async function collectTennisEvents(matchDate, horizonDays) {
  const dates = collectDateList(matchDate, horizonDays);
  const dateSet = new Set(dates);
  const events = [];
  const seen = new Set();
  const sofaRangeIds = new Set();
  let pagesTotal = 0;
  let detailFetched = 0;
  let detailErrors = 0;
  const tierSeen = new Set();

  const add = (ev, fromDay) => {
    const eid = ev.id;
    if (eid == null) return;
    if (seen.has(eid)) {
      if (fromDay && dateSet.has(fromDay)) sofaRangeIds.add(eid);
      return;
    }
    seen.add(eid);
    if (fromDay && dateSet.has(fromDay)) sofaRangeIds.add(eid);
    events.push(ev);
  };

  const isActiveOnDates = (ev) => {
    if (isEnded(ev)) return false;
    if (isLive(ev)) return true;
    const local = eventLocalDate(ev);
    return local && dateSet.has(local);
  };

  const live = await fetchLiveTennisEvents();
  for (const ev of live.events) {
    if (isTierEvent(ev)) add(ev);
  }

  for (const d of dates) {
    const { tournaments: listed, pages } = await listScheduledTournaments(d);
    pagesTotal += pages;
    for (const tournament of listed) {
      if (!isTierTournament(tournament)) continue;
      const tid = tournament.id;
      if (tid != null && tierSeen.has(tid)) continue;
      if (tid != null) tierSeen.add(tid);
      detailFetched += 1;
      try {
        const detail = await fetchTournamentEvents(tournament);
        for (const ev of detail) {
          if (isActiveOnDates(ev)) add(ev, d);
        }
      } catch (err) {
        detailErrors += 1;
        console.warn('[tennis/full-collect] tier skip:', err.message || err);
      }
    }
  }

  const kept = [];
  for (const ev of events) {
    if (isEnded(ev)) continue;
    if (isLive(ev)) {
      kept.push(ev);
      continue;
    }
    const bj = eventLocalDate(ev);
    if ((bj && dateSet.has(bj)) || sofaRangeIds.has(ev.id)) kept.push(ev);
  }

  return {
    events: kept,
    stats: {
      date: matchDate,
      date_end: dates[dates.length - 1],
      horizon_days: horizonDays,
      pages: pagesTotal,
      tier_detail_fetched: detailFetched,
      tier_detail_errors: detailErrors,
      kept_events: kept.length,
    },
  };
}

function buildBundlePayload(collect) {
  const events = collect.events || [];
  const live = events.filter((e) => LIVE_TYPES.has(String(e.statusType || '').toLowerCase()));
  const fetchedAt = new Date().toISOString();
  const dataFilter = collect.top100 ? 'top100' : 'tier';
  const top100Board = collect.rankingsBoard
    ? {
        atp: collect.rankingsBoard.atp || [],
        wta: collect.rankingsBoard.wta || [],
        summary: collect.rankingsBoard.summary || {
          total_matches: events.length,
          atp_players: (collect.rankingsBoard.atp || []).length,
          wta_players: (collect.rankingsBoard.wta || []).length,
        },
      }
    : null;
  return {
    ok: true,
    sport: 'tennis',
    date: collect.date,
    fetched_at: fetchedAt,
    filter: dataFilter,
    dataFilter,
    top_rank_max: collect.top100 ? TOP_N : null,
    exclude_ended: true,
    source: 'tennis-collect',
    upstream: 'ipwo',
    dataSource: 'collect',
    collectScript: 'tennisFullCollect',
    scheduled: groupScheduled(events),
    live: {
      matches: live,
      ...groupScheduled(live),
    },
    rankingsByPlayer: collect.rankingsByPlayer || {},
    oddsByEvent: collect.oddsByEvent || {},
    polymarketByEvent: collect.polymarketByEvent || {},
    birthYearByPlayer: collect.birthYearByPlayer || {},
    top100: top100Board,
    rankingsBoard: top100Board,
    requests: collect.requests,
    timing: collect.timing,
    events: events.length,
    serverTime: Math.floor(Date.now() / 1000),
    update: { message: `tennisFullCollect → Redis · ${events.length} events` },
    member: true,
    message: `collect→redis · ${events.length} events`,
  };
}

async function ensureProxyEnv(job = 'top100') {
  const cfg = await tennisEngines.getConfig();
  const proxyUrl = String(process.env.SOFA_HTTP_PROXY || process.env.HTTP_PROXY || '').trim();
  const ipwo = {
    host: process.env.IPWO_PROXY_HOST || '',
    port: process.env.IPWO_PROXY_PORT || '',
    user: process.env.IPWO_PROXY_USER || '',
    pass: process.env.IPWO_PROXY_PASS || '',
    zone: process.env.IPWO_PROXY_ZONE || '',
    session: process.env.IPWO_PROXY_SESSION || '',
    stickyMin: process.env.IPWO_PROXY_STICKY_MIN || '',
  };
  Object.assign(process.env, tennisEngines.buildProxyProcessEnv(cfg, job, { proxyUrl, ipwo }));
  const sofaCurl = require('./tennisSofascoreCurl');
  sofaCurl.closeWorker();
  sofaCurl.resetProbe();
  return sofaCurl;
}

async function runFullCollect(opts = {}) {
  const pause = require('./tennisBackgroundPause');
  pause.pauseTennisBackgroundRefresh('full-collect');
  try {
    return await runFullCollectInner(opts);
  } finally {
    pause.resumeTennisBackgroundRefresh();
  }
}

/**
 * @param {{ matchDate?: string|null, top100?: boolean, horizonDays?: number, onLog?: (line: string) => void }} opts
 */
async function runFullCollectInner(opts = {}) {
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : (line) => console.log(line);
  const top100 = opts.top100 !== false;
  const horizonDays = opts.horizonDays ?? readHorizonDays();
  const matchDate = opts.matchDate || todayBj();
  const runStarted = Date.now();
  const timing = {};
  const dates = collectDateList(matchDate, horizonDays);
  const rangeLabel =
    horizonDays > 1 ? `${matchDate}..${dates[dates.length - 1]}（${horizonDays}天）` : matchDate;

  onLog(`=== 网球采集 ${rangeLabel} (Node) ===`);
  const sofaCurl = await ensureProxyEnv('top100');
  const sofaVia = sofaCurl.isEnabled()
    ? 'curl_cffi'
    : String(process.env.SOFA_USE_NODE_HTTP || '').trim() === '1'
      ? 'Node(https)'
      : null;
  if (!sofaVia) {
    const note = typeof sofaCurl.probeNote === 'function' ? sofaCurl.probeNote() : '';
    throw new Error(
      `Sofascore curl_cffi 不可用${note ? ` (${note})` : ''}，无法采集。请重建 server/collect 镜像或安装 scripts/tennis-monitor/requirements.txt 后重启。`,
    );
  }

  let t0 = Date.now();
  onLog(`[1/${STEPS}] 直连就绪 · Sofascore=${sofaVia}`);
  timing.step1 = (Date.now() - t0) / 1000;

  t0 = Date.now();
  let board = null;
  let rawEvents = [];
  if (top100) {
    board = await fetchRankBoard(TOP_N);
    onLog(`      排名榜 ATP ${board.atp.length} 人 · WTA ${board.wta.length} 人`);
  }
  const collected = await collectTennisEvents(matchDate, horizonDays);
  rawEvents = collected.events;
  const tierBefore = rawEvents.length;
  if (top100 && board) {
    rawEvents = rawEvents.filter((ev) => eventMatchesBoard(ev, board));
  }
  timing.step2 = (Date.now() - t0) / 1000;
  onLog(`[2/${STEPS}] 赛事 ${tierBefore} → ${rawEvents.length} 场`);

  const slimEvents = rawEvents.map(slimEvent);
  let polymarketByEvent = {};
  t0 = Date.now();
  if (slimEvents.length) {
    onLog(`[3/${STEPS}] Polymarket：${slimEvents.length} 场`);
    const preBundle = buildBundlePayload({
      date: matchDate,
      top100,
      events: slimEvents,
      rankingsBoard: board,
      rankingsByPlayer: rankingsFromBoard(board || { atp: [], wta: [] }),
    });
    const poly = await applyPolymarketLinks(preBundle);
    polymarketByEvent = preBundle.polymarketByEvent || {};
    onLog(`      PM linked=${poly.matched ?? Object.keys(polymarketByEvent).length}`);
  } else {
    onLog(`[3/${STEPS}] Polymarket：0 场`);
  }
  timing.step3 = (Date.now() - t0) / 1000;

  t0 = Date.now();
  const rankingsByPlayer = rankingsFromBoard(board || { atp: [], wta: [] });
  if (board && slimEvents.length) attachBoardMatches(board, slimEvents);
  timing.step4 = (Date.now() - t0) / 1000;
  onLog(`[4/${STEPS}] 排名 ${Object.keys(rankingsByPlayer).length} 人`);

  const rankingsBoard = board
    ? {
        atp: board.atp,
        wta: board.wta,
        summary: {
          total_matches: slimEvents.length,
          atp_players: board.atp.length,
          wta_players: board.wta.length,
          atp_matches: board.atp.reduce((n, p) => n + (p.matchCount || 0), 0),
          wta_matches: board.wta.reduce((n, p) => n + (p.matchCount || 0), 0),
        },
      }
    : null;

  const bundle = buildBundlePayload({
    date: matchDate,
    top100,
    events: slimEvents,
    rankingsBoard,
    rankingsByPlayer,
    polymarketByEvent,
    oddsByEvent: {},
    requests: {
      http_total: collected.stats.tier_detail_fetched * 2 + collected.stats.pages + 2,
      rankings: top100 ? 2 : 0,
      scheduled_pages: collected.stats.pages,
      tier_detail: collected.stats.tier_detail_fetched,
      polymarket: Object.keys(polymarketByEvent).length,
    },
    timing,
  });

  t0 = Date.now();
  onLog(`[6/${STEPS}] 写入 Redis tennis:bundle:full`);
  const written = await tennisCache.setCachedBundle(bundle, bundle.fetched_at);
  let split = null;
  if (written) {
    split = await tennisThreeBuckets.splitFullToThreeBuckets(bundle);
    onLog(
      `      拆桶 prematch=${split.prematch ?? 0} inplay=${split.inplay ?? 0} settled=${split.settled ?? 0}`,
    );
  }
  timing.step6 = (Date.now() - t0) / 1000;
  timing.total = (Date.now() - runStarted) / 1000;
  bundle.timing = timing;

  const redis = written
    ? {
        ok: true,
        key: 'tennis:bundle:full',
        events: slimEvents.length,
        also: ['tennis:bundle:prematch', 'tennis:bundle:inplay', 'tennis:bundle:settled'],
        split,
      }
    : { ok: false, error: 'Redis write failed' };

  onLog(
    written
      ? `完成: ${slimEvents.length} 场 · Redis ✓ · 总耗时 ${formatDuration(timing.total)}`
      : `完成: Redis 失败 · ${slimEvents.length} 场`,
  );

  return {
    ok: written,
    date: matchDate,
    total_events: slimEvents.length,
    events: slimEvents,
    persist: { redis },
    timing,
    requests: bundle.requests,
    top100,
  };
}

module.exports = {
  runFullCollect,
  readHorizonDays,
  todayBj,
};
