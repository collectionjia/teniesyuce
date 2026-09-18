/**
 * 盘中 tick：网球源刷比分 + Polymarket 刷赔率 → 写入盘中包供「比赛进行中」展示
 */
const tennisInplayCache = require('./tennisInplayCache');
const tennisPolymarket = require('./tennisPolymarket');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisEngines = require('./tennisEngines');
const tennisLive = require('./tennisLive');

function matchKey(home, away) {
  const h = String(home || '').trim().toLowerCase();
  const a = String(away || '').trim().toLowerCase();
  if (!h || !a) return '';
  return `${h}|${a}`;
}

function indexLiveEvents(events) {
  const byId = new Map();
  const byName = new Map();
  for (const e of events || []) {
    if (!e) continue;
    if (e.id != null) byId.set(String(e.id), e);
    const k = matchKey(e.home || e.homePlayer?.name, e.away || e.awayPlayer?.name);
    if (k) byName.set(k, e);
  }
  return { byId, byName };
}

function pickLiveSource(m, index) {
  if (!m || !index) return null;
  if (m.id != null && index.byId.has(String(m.id))) return index.byId.get(String(m.id));
  const k = matchKey(m.home || m.homePlayer?.name, m.away || m.awayPlayer?.name);
  return k ? index.byName.get(k) || null : null;
}

/** 从网球 live 源刷新盘中包比分/状态 */
async function refreshScoresOntoInplay(bundle) {
  if (!bundle) return { updated: 0, liveFeed: 0, skipped: true, reason: 'no bundle' };
  let events = [];
  try {
    events = (await tennisLive.fetchMonitorLiveEventsFresh(true)) || [];
  } catch (e) {
    console.warn('[inplay-tick] tennis score fetch:', e.message || e);
    return { updated: 0, liveFeed: 0, error: e.message || String(e) };
  }
  const index = indexLiveEvents(events);
  const at = new Date().toISOString();
  let updated = 0;
  const matches = (bundle.live?.matches || []).map((m) => {
    const src = pickLiveSource(m, index);
    if (!src) return m;
    updated += 1;
    const next = tennisLive.applyServiceEvent(m, src);
    return { ...next, score_updated_at: at };
  });
  bundle.live = {
    ...(bundle.live || {}),
    matches,
    eventCount: matches.length,
    tournaments: bundle.live?.tournaments || [],
    tournamentCount: bundle.live?.tournamentCount || 0,
  };
  bundle.events = matches.length;
  bundle.score_updated_at = at;
  return { updated, liveFeed: events.length };
}

async function runInplayTick({ skipBetting = false } = {}) {
  const tennisDataSource = require('./tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return { ok: false, skipped: true, reason: 'virtual docks500 skips live tick' };
  }
  const cfg = await tennisEngines.getConfig();
  if (cfg.collect?.enabled === false) {
    return { ok: false, skipped: true, reason: 'collect engine disabled' };
  }
  if (cfg.collect?.inplay_tick_enabled === false) {
    return { ok: false, skipped: true, reason: 'tick disabled' };
  }

  const fields = cfg.collect?.inplay_tick_fields || {};
  const wantOdds = fields.odds !== false;
  const wantScore = fields.score !== false;

  const migratePre = await tennisThreeBuckets.migratePrematchByStartTime();
  const admitLive = await tennisThreeBuckets.admitLiveFromFull();

  let bundle = await tennisInplayCache.getBundle();
  if (!bundle) {
    bundle = {
      ok: true,
      source: 'tennis-inplay',
      live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
      rankingsByPlayer: {},
      polymarketByEvent: {},
      oddsByEvent: {},
      events: 0,
    };
  }

  let scores = { updated: 0, liveFeed: 0, skipped: !wantScore };
  if (wantScore) {
    scores = await refreshScoresOntoInplay(bundle);
  } else {
    scores = { updated: 0, liveFeed: 0, skipped: true, reason: 'score field off' };
  }

  let prices = { updated: 0, failed: 0, skipped: !wantOdds };
  if (wantOdds) {
    prices = await tennisPolymarket.refreshPolymarketPrices(bundle);
    bundle.odds_updated_at = new Date().toISOString();
  } else {
    prices = { updated: 0, failed: 0, skipped: true, reason: 'odds field off' };
  }

  const tickAt = new Date().toISOString();
  bundle.tick_at = tickAt;
  bundle.fetched_at = tickAt;
  bundle.serverTime = Math.floor(Date.now() / 1000);
  if (wantScore && !bundle.score_updated_at) bundle.score_updated_at = tickAt;
  if (wantOdds && !bundle.odds_updated_at) bundle.odds_updated_at = tickAt;

  await tennisInplayCache.setCachedBundle(bundle);

  const migrateEnd = await tennisThreeBuckets.migrateInplayEnded();

  let betting = null;
  if (!skipBetting) {
    try {
      const tennisBettingEngine = require('./tennisBettingEngine');
      betting = await tennisBettingEngine.runBettingPass({});
    } catch (e) {
      betting = { ok: false, error: e.message };
    }
  }

  return {
    ok: true,
    tick_at: tickAt,
    score_updated_at: bundle.score_updated_at || null,
    odds_updated_at: bundle.odds_updated_at || null,
    fields: { score: wantScore, odds: wantOdds },
    scores,
    prices,
    migrated_prematch_to_inplay: migratePre.moved || 0,
    admitted_live_from_full: admitLive.admitted || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
    inplay_matches: bundle.live?.matches?.length || 0,
    betting,
  };
}

module.exports = { runInplayTick, refreshScoresOntoInplay };
