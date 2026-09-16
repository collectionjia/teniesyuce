/**
 * 全量包拆三桶 + 开赛迁盘中 + 结束迁盘后
 */
const tennisCache = require('./tennisCache');
const tennisPrematchCache = require('./tennisPrematchCache');
const tennisInplayCache = require('./tennisInplayCache');
const tennisSettledCache = require('./tennisSettledCache');
const redis = require('./redis');

const META_TODAY_KEY = 'tennis:bundle:meta:today';
const TTL_SEC = Number(process.env.TENNIS_CACHE_TTL_SEC || 86400);

const LIVE_TYPES = new Set(['inprogress', 'live', 'interrupted']);
const ENDED_TYPES = new Set(['finished', 'ended', 'closed', 'retired', 'walkover', 'cancelled', 'canceled', 'postponed']);

function statusTypeOf(m) {
  return String(m?.statusType || m?.status?.type || m?.status || '').toLowerCase();
}

function isLive(m) {
  if (m?.virtualPhase === 'inplay') return true;
  return LIVE_TYPES.has(statusTypeOf(m));
}

function isEnded(m) {
  if (m?.virtualPhase === 'settled') return true;
  if (m?.virtualPhase === 'prematch' || m?.virtualPhase === 'inplay') return false;
  const t = statusTypeOf(m);
  if (ENDED_TYPES.has(t)) return true;
  if (m?.status?.code === 100 || m?.status?.code === 60) return true;
  return false;
}

function isNotStarted(m) {
  if (isLive(m) || isEnded(m)) return false;
  return true;
}

function currentRank(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId;
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null;
  const n = Number(fromMap?.current ?? player?.ranking ?? player?.currentRank);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function strongRank(m, rankingsByPlayer) {
  const homeR = currentRank(m?.homePlayer || { name: m?.home }, rankingsByPlayer);
  const awayR = currentRank(m?.awayPlayer || { name: m?.away }, rankingsByPlayer);
  if (homeR == null || awayR == null) return null;
  return Math.min(homeR, awayR);
}

function passesTop100(m, rankingsByPlayer) {
  const r = strongRank(m, rankingsByPlayer);
  return r != null && r <= 100;
}

function flattenMatches(bundle) {
  if (!bundle) return [];
  const tournaments = bundle.scheduled?.tournaments || [];
  const fromSched = tournaments.flatMap((t) =>
    (t.events || []).map((e) => ({
      ...e,
      tournament: e.tournament || t.name,
      level: e.level || t.level,
    }))
  );
  const live = bundle.live?.matches || [];
  const byId = new Map();
  for (const m of fromSched) {
    if (m?.id != null) byId.set(String(m.id), m);
  }
  for (const m of live) {
    if (m?.id == null) continue;
    const id = String(m.id);
    const prev = byId.get(id);
    byId.set(id, prev ? { ...prev, ...m } : m);
  }
  return [...byId.values()];
}

function groupScheduled(events) {
  const groups = {};
  for (const ev of events) {
    const key = ev.tournament || ev.tournamentShort || 'Other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(ev);
  }
  const tournaments = Object.entries(groups).map(([name, items]) => ({ name, events: items }));
  return {
    tournaments,
    tournamentCount: tournaments.length,
    eventCount: events.length,
  };
}

function baseShell(bundle, { source, matches, liveOnly = false }) {
  const rankings = bundle.rankingsByPlayer || {};
  const skipTop = bundle?.upstream === 'docks500'
    || bundle?.dataSource === 'docks500'
    || bundle?.source === 'docks500'
    || !!bundle?.virtualSim
    || String(source || '').includes('docks');
  const filtered = skipTop ? [...matches] : matches.filter((m) => passesTop100(m, rankings));
  const live = liveOnly ? filtered : filtered.filter(isLive);
  const scheduled = liveOnly ? [] : filtered.filter(isNotStarted);
  const ended = filtered.filter(isEnded);
  const liveGroup = groupScheduled(live);
  const schedGroup = groupScheduled(liveOnly ? [] : scheduled);
  const settledGroup = groupScheduled(ended);
  return {
    ok: true,
    sport: 'tennis',
    date: bundle.date,
    fetched_at: bundle.fetched_at || new Date().toISOString(),
    source,
    upstream: bundle.upstream || 'ipwo',
    rankingsByPlayer: rankings,
    oddsByEvent: bundle.oddsByEvent || {},
    polymarketByEvent: bundle.polymarketByEvent || {},
    eloByEvent: bundle.eloByEvent || {},
    birthYearByPlayer: bundle.birthYearByPlayer || {},
    theOddsApiByEvent: bundle.theOddsApiByEvent || {},
    serverTime: Math.floor(Date.now() / 1000),
    scheduled: liveOnly
      ? { tournaments: [], tournamentCount: 0, eventCount: 0 }
      : source.includes('settled')
        ? settledGroup
        : schedGroup,
    live: source.includes('settled')
      ? {
          matches: ended,
          tournaments: settledGroup.tournaments,
          tournamentCount: settledGroup.tournamentCount,
          eventCount: ended.length,
        }
      : {
          matches: live,
          tournaments: liveGroup.tournaments,
          tournamentCount: liveGroup.tournamentCount,
          eventCount: live.length,
        },
    events: liveOnly ? live.length : source.includes('settled') ? ended.length : scheduled.length + live.length,
  };
}

async function writeMeta(bundle) {
  const client = await redis.getClient();
  if (!client || !bundle) return;
  const meta = {
    fetched_at: bundle.fetched_at,
    date: bundle.date,
    rankingsByPlayer: bundle.rankingsByPlayer || {},
    oddsByEvent: bundle.oddsByEvent || {},
    polymarketByEvent: bundle.polymarketByEvent || {},
    eloByEvent: bundle.eloByEvent || {},
    birthYearByPlayer: bundle.birthYearByPlayer || {},
  };
  await client.set(META_TODAY_KEY, JSON.stringify(meta), { EX: TTL_SEC });
}

/** 从 full（或任意合包）拆写 prematch / inplay / settled + meta */
async function splitFullToThreeBuckets(fullBundle) {
  const bundle = fullBundle || (await tennisCache.getBundle());
  if (!bundle) return { ok: false, error: 'no full bundle' };
  const all = flattenMatches(bundle);
  const rankings = bundle.rankingsByPlayer || {};
  // 虚拟 txt 回放已按相位造好盘前/盘中/盘后，不再用 Top100 滤光
  const skipTop = bundle?.upstream === 'docks500'
    || bundle?.dataSource === 'docks500'
    || bundle?.source === 'docks500'
    || !!bundle?.virtualSim;
  const top = skipTop ? all : all.filter((m) => passesTop100(m, rankings));

  const prematchMatches = top.filter(isNotStarted);
  const inplayMatches = top.filter(isLive);
  const settledMatches = top.filter(isEnded);

  const prematch = {
    ...baseShell(bundle, { source: 'tennis-prematch', matches: prematchMatches }),
    scheduled: groupScheduled(prematchMatches),
    live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
    events: prematchMatches.length,
    message: `prematch · ${prematchMatches.length}`,
  };
  const inplay = {
    ...baseShell(bundle, { source: 'tennis-inplay', matches: inplayMatches, liveOnly: true }),
    message: `inplay · ${inplayMatches.length}`,
  };
  if (skipTop) {
    inplay.upstream = 'docks500';
    inplay.dataSource = 'docks500';
    inplay.virtualSim = bundle.virtualSim || true;
  }
  // settled: put ended in live.matches for TennisBoard compatibility
  const settledGrouped = groupScheduled(settledMatches);
  const settled = {
    ok: true,
    sport: 'tennis',
    date: bundle.date,
    fetched_at: bundle.fetched_at || new Date().toISOString(),
    source: 'tennis-settled',
    rankingsByPlayer: rankings,
    oddsByEvent: bundle.oddsByEvent || {},
    polymarketByEvent: bundle.polymarketByEvent || {},
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: {
      matches: settledMatches,
      tournaments: settledGrouped.tournaments,
      tournamentCount: settledGrouped.tournamentCount,
      eventCount: settledMatches.length,
    },
    events: settledMatches.length,
    serverTime: Math.floor(Date.now() / 1000),
    message: `settled · ${settledMatches.length}`,
  };

  await tennisPrematchCache.setCachedBundle(prematch);
  await tennisInplayCache.setCachedBundle(inplay);
  await tennisSettledCache.setCachedBundle(settled);
  await writeMeta(bundle);

  return {
    ok: true,
    prematch: prematchMatches.length,
    inplay: inplayMatches.length,
    settled: settledMatches.length,
  };
}

/** 盘前开赛时间已过 → 立即迁 inplay */
async function migratePrematchByStartTime(nowMs = Date.now()) {
  const pre = await tennisPrematchCache.getBundle();
  if (!pre) return { moved: 0 };
  const rankings = pre.rankingsByPlayer || {};
  const tournaments = pre.scheduled?.tournaments || [];
  const keep = [];
  const move = [];
  for (const t of tournaments) {
    for (const e of t.events || []) {
      const ts = Number(e.startTimestamp || e.start_time || 0);
      const startMs = ts > 1e12 ? ts : ts * 1000;
      if (startMs > 0 && startMs <= nowMs && passesTop100(e, rankings)) {
        move.push({ ...e, tournament: e.tournament || t.name, statusType: e.statusType || 'inprogress' });
      } else {
        keep.push({ ...e, tournament: e.tournament || t.name });
      }
    }
  }
  if (!move.length) return { moved: 0 };

  const inplay = (await tennisInplayCache.getBundle()) || {
    ok: true,
    live: { matches: [] },
    rankingsByPlayer: rankings,
    polymarketByEvent: pre.polymarketByEvent || {},
    oddsByEvent: pre.oddsByEvent || {},
  };
  const byId = new Map((inplay.live?.matches || []).map((m) => [String(m.id), m]));
  for (const m of move) byId.set(String(m.id), m);
  inplay.live = {
    matches: [...byId.values()],
    tournaments: [],
    tournamentCount: 0,
    eventCount: byId.size,
  };
  inplay.events = byId.size;
  inplay.fetched_at = new Date().toISOString();
  inplay.tick_at = inplay.fetched_at;
  inplay.rankingsByPlayer = { ...rankings, ...(inplay.rankingsByPlayer || {}) };
  inplay.polymarketByEvent = { ...(pre.polymarketByEvent || {}), ...(inplay.polymarketByEvent || {}) };

  const keepGrouped = groupScheduled(keep);
  pre.scheduled = keepGrouped;
  pre.events = keep.length;
  pre.fetched_at = new Date().toISOString();

  await tennisPrematchCache.setCachedBundle(pre);
  await tennisInplayCache.setCachedBundle(inplay);
  return { moved: move.length };
}

/**
 * 全量包里已 live 且 Top100、尚未进 inplay 的场次 → 直接纳入盘中
 *（tick 期间新开赛、不全依赖盘前迁桶）
 */
async function admitLiveFromFull() {
  const tennisDataSource = require('./tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return { admitted: 0, skipped: true, reason: 'virtual' };
  }
  const full = await tennisCache.getBundle();
  if (!full) return { admitted: 0 };
  // 全量仍是虚拟包时不要往盘中掺
  if (full.upstream === 'docks500' || full.dataSource === 'docks500' || full.virtualSim) {
    return { admitted: 0, skipped: true, reason: 'full is virtual' };
  }
  const rankings = full.rankingsByPlayer || {};
  const candidates = flattenMatches(full).filter(
    (m) => isLive(m) && passesTop100(m, rankings)
  );
  if (!candidates.length) return { admitted: 0 };

  const inplay = (await tennisInplayCache.getBundle()) || {
    ok: true,
    live: { matches: [] },
    rankingsByPlayer: rankings,
    polymarketByEvent: full.polymarketByEvent || {},
    oddsByEvent: full.oddsByEvent || {},
  };
  const byId = new Map((inplay.live?.matches || []).map((m) => [String(m.id), m]));
  let admitted = 0;
  for (const m of candidates) {
    const id = String(m.id);
    if (!byId.has(id)) admitted += 1;
    byId.set(id, { ...(byId.get(id) || {}), ...m });
  }

  inplay.live = {
    matches: [...byId.values()],
    tournaments: [],
    tournamentCount: 0,
    eventCount: byId.size,
  };
  inplay.events = byId.size;
  inplay.fetched_at = new Date().toISOString();
  inplay.tick_at = inplay.fetched_at;
  inplay.rankingsByPlayer = { ...rankings, ...(inplay.rankingsByPlayer || {}) };
  inplay.polymarketByEvent = { ...(full.polymarketByEvent || {}), ...(inplay.polymarketByEvent || {}) };
  inplay.oddsByEvent = { ...(full.oddsByEvent || {}), ...(inplay.oddsByEvent || {}) };

  await tennisInplayCache.setCachedBundle(inplay);
  return { admitted, refreshed: candidates.length };
}

/** 盘中已结束 → 立即迁 settled 并删 inplay */
async function migrateInplayEnded() {
  const inplay = await tennisInplayCache.getBundle();
  if (!inplay) return { moved: 0 };
  const matches = inplay.live?.matches || [];
  const still = [];
  const ended = [];
  for (const m of matches) {
    if (isEnded(m)) ended.push(m);
    else still.push(m);
  }
  if (!ended.length) return { moved: 0 };

  const settled = (await tennisSettledCache.getBundle()) || {
    ok: true,
    live: { matches: [] },
    rankingsByPlayer: inplay.rankingsByPlayer || {},
    polymarketByEvent: inplay.polymarketByEvent || {},
  };
  const byId = new Map((settled.live?.matches || []).map((m) => [String(m.id), m]));
  for (const m of ended) byId.set(String(m.id), m);
  const settledList = [...byId.values()];
  const g = groupScheduled(settledList);
  settled.live = {
    matches: settledList,
    tournaments: g.tournaments,
    tournamentCount: g.tournamentCount,
    eventCount: settledList.length,
  };
  settled.events = settledList.length;
  settled.fetched_at = new Date().toISOString();
  settled.rankingsByPlayer = { ...(inplay.rankingsByPlayer || {}), ...(settled.rankingsByPlayer || {}) };
  settled.polymarketByEvent = { ...(inplay.polymarketByEvent || {}), ...(settled.polymarketByEvent || {}) };

  inplay.live = {
    matches: still,
    tournaments: [],
    tournamentCount: 0,
    eventCount: still.length,
  };
  inplay.events = still.length;
  inplay.fetched_at = new Date().toISOString();
  inplay.tick_at = inplay.fetched_at;

  await tennisInplayCache.setCachedBundle(inplay);
  await tennisSettledCache.setCachedBundle(settled);
  return { moved: ended.length };
}

/**
 * 虚拟采集：默认用 docks/2026_500.txt 模拟盘前/盘中/盘后，写入 Redis 三桶。
 * 不使用 Sofascore/IPWO 真实采集包。
 */
async function seedVirtualPrematchInplay(opts = {}) {
  const tennisDocks500 = require('./tennisDocks500');
  const tennisDataSource = require('./tennisDataSource');
  const txtName = opts.txtName || '2026_500.txt';

  try {
    await tennisDataSource.set('docks500');
  } catch (e) {
    console.warn('[tennis/seed-virtual] set data-source', e.message);
  }

  try {
    tennisDocks500.ensureByDayFromTxt({ force: !!opts.forceRebuild, txtName });
  } catch (e) {
    return { ok: false, error: e.message || `找不到 docks/${txtName}` };
  }

  if (opts.date) {
    try {
      await tennisDocks500.setSelectedDate(opts.date);
    } catch (e) {
      return { ok: false, error: e.message || '虚拟日期无效' };
    }
  }

  let date = opts.date || (await tennisDocks500.getSelectedDate());
  const days = tennisDocks500.listDays();
  if (!date && days.length) date = days[0].date;
  if (!date) return { ok: false, error: `docks/${txtName} 无可用按日数据` };

  let bundle;
  try {
    bundle = tennisDocks500.loadDayBundle(date, { simulate: false });
  } catch (e) {
    return { ok: false, error: e.message || '读取 txt 日包失败' };
  }

  const all = flattenMatches(bundle).map((m) => ({ ...m }));
  if (!all.length) return { ok: false, error: 'txt 日包无场次' };

  const working = {
    ...bundle,
    scheduled: groupScheduled(all),
    live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
    fetched_at: new Date().toISOString(),
    date,
    dataSource: 'docks500',
    upstream: 'docks500',
    source: 'docks500',
    txtSource: txtName,
  };

  tennisDocks500.applyVirtualPhases(working, {
    prematchCount: opts.prematchCount,
    inplayCount: opts.inplayCount,
  });

  const wrote = await tennisCache.setCachedBundle(working);
  if (!wrote) return { ok: false, error: '写入 Redis 全量包失败（检查 Redis）' };

  const split = await splitFullToThreeBuckets(working);
  return {
    ok: true,
    from: 'docks-txt',
    date,
    txtSource: txtName,
    ...split,
    virtualSim: working.virtualSim || null,
    message:
      working.message
      || `虚拟采集 · docks/${txtName} · ${date} · 盘前${split.prematch} / 盘中${split.inplay} / 盘后${split.settled}`,
  };
}

module.exports = {
  splitFullToThreeBuckets,
  migratePrematchByStartTime,
  migrateInplayEnded,
  admitLiveFromFull,
  seedVirtualPrematchInplay,
  isLive,
  isEnded,
  isNotStarted,
  META_TODAY_KEY,
};
