/**
 * 盘中 tick：迁桶 / PM 结算打标 / 可选投注。
 * 赔率写入：collect.top100 全量、poly-odds 后台循环、手动单场刷新。
 */
const tennisInplayCache = require('./tennisInplayCache');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisEngines = require('./tennisEngines');
const tennisPolymarket = require('./tennisPolymarket');
const { applyPmSettle } = require('./tennisInplayMatchQuery');

function applyPmSettleOntoInplay(bundle) {
  if (!bundle?.live?.matches?.length) return { settled: 0 };
  const polyMap = bundle.polymarketByEvent || {};
  let settled = 0;
  for (const m of bundle.live.matches) {
    if (!m || m.id == null) continue;
    const poly = polyMap[String(m.id)] || polyMap[m.id];
    if (!poly) continue;
    const next = applyPmSettle(m, poly);
    if (next.pmSettled && !m.pmSettled) settled += 1;
    Object.assign(m, next);
    if (m.pmSettled) tennisThreeBuckets.applyPhaseMark(m, 'ended');
  }
  return { settled };
}

async function stampInplayRefreshTimes(bundle, { odds = false } = {}) {
  if (!bundle) return bundle;
  const at = new Date().toISOString();
  bundle.tick_at = at;
  bundle.fetched_at = bundle.fetched_at || at;
  bundle.serverTime = Math.floor(Date.now() / 1000);
  bundle.upstream = bundle.upstream || 'polymarket';
  if (odds) bundle.odds_updated_at = at;
  await tennisInplayCache.setCachedBundle(bundle);
  return bundle;
}

/** Top100 高频：仅刷盘中 Polymarket 赔率 → Redis */
async function refreshInplayOddsTick() {
  const tennisDataSource = require('./tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return {
      ok: false,
      skipped: true,
      reason: 'virtual docks500 skips odds refresh',
      process_log: '[top100-hf] skipped: virtual docks500',
    };
  }
  const cfg = await tennisEngines.getConfig();
  if (cfg.collect?.enabled === false) {
    return {
      ok: false,
      skipped: true,
      reason: 'collect engine disabled',
      process_log: '[top100-hf] skipped: collect engine disabled',
    };
  }

  const bundle = await tennisInplayCache.getBundle();
  const matchCount = bundle?.live?.matches?.length || 0;
  if (!matchCount) {
    return {
      ok: true,
      skipped: true,
      updated: 0,
      failed: 0,
      reason: 'no inplay matches in redis',
      process_log: '[top100-hf] no inplay matches',
    };
  }

  process.env.COLLECT_PROXY_JOB = 'inplay';
  process.env.COLLECT_INPLAY_USE_PROXY = '0';
  const p = await tennisPolymarket.refreshInplayOddsOnce({ clobOnly: true });
  const oddsLog = (p.rows || [])
    .map((row) =>
      row.ok
        ? `[odds] ok id=${row.id} slug=${row.slug} ${row.home_price}/${row.away_price}`
        : `[odds] fail id=${row.id} slug=${row.slug || '-'} ${row.error || 'fail'}`,
    )
    .join('\n');
  if (Number(p.failed) > 0) {
    console.warn('[top100-hf] odds refresh failed:', {
      updated: p.updated,
      failed: p.failed,
      error: p.error,
    });
  }

  const fresh = await tennisInplayCache.getBundle();
  if (fresh && p.ok !== false) {
    await stampInplayRefreshTimes(fresh, { odds: true });
  }

  const prices = {
    updated: Number(p.updated) || 0,
    failed: Number(p.failed) || 0,
    skipped: false,
    ok: p.ok !== false,
    error: p.error || null,
    via: 'polymarket-clob',
    upstream: 'polymarket-direct',
    script: 'tennisPolymarket.js',
    summary: p,
  };

  return {
    ok: p.written && p.ok !== false,
    tick_at: fresh?.tick_at || p.odds_updated_at || null,
    odds_updated_at: p.odds_updated_at || fresh?.odds_updated_at || null,
    prices,
    process_log: [
      `[top100-hf] inplay=${matchCount}`,
      `[odds] scanned=${p.scanned || 0} updated=${prices.updated} failed=${prices.failed}`,
      oddsLog,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function runInplayTick({ skipBetting = false } = {}) {
  const tennisDataSource = require('./tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return {
      ok: false,
      skipped: true,
      reason: 'virtual docks500 skips live tick',
      process_log: '[inplay-tick] skipped: virtual docks500',
    };
  }
  const cfg = await tennisEngines.getConfig();
  if (cfg.collect?.enabled === false) {
    return {
      ok: false,
      skipped: true,
      reason: 'collect engine disabled',
      process_log: '[inplay-tick] skipped: collect engine disabled',
    };
  }
  if (cfg.collect?.inplay_tick_enabled === false) {
    return {
      ok: false,
      skipped: true,
      reason: 'tick disabled',
      process_log: '[inplay-tick] skipped: inplay_tick disabled',
    };
  }

  const migratePre = await tennisThreeBuckets.migratePrematchByStartTime();
  const admitLive = await tennisThreeBuckets.admitLiveFromFull();

  const scores = {
    updated: 0,
    skipped: true,
    reason: 'score fetch removed from scheduler tick',
    upstream: 'n/a',
  };
  const prices = {
    updated: 0,
    failed: 0,
    skipped: true,
    reason: 'odds only via full collect / poly-odds loop / manual refresh',
    upstream: 'n/a',
  };
  const refreshLogs = [
    '[score] skipped (not in scheduler tick)',
    '[odds] skipped (use full collect / poly-odds loop)',
  ];

  let bundle = await tennisInplayCache.getBundle();
  const matchCount = bundle?.live?.matches?.length || 0;

  bundle = await tennisInplayCache.getBundle();
  const pmSettle = applyPmSettleOntoInplay(bundle);
  if (bundle && pmSettle.settled > 0) {
    await tennisInplayCache.setCachedBundle(bundle);
  }

  const migrateEnd = await tennisThreeBuckets.migrateInplayEnded();
  const phaseMarks = await tennisThreeBuckets.stampPhaseMarks();
  bundle = await tennisInplayCache.getBundle();
  const tickAt = bundle?.tick_at || new Date().toISOString();

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
    score_updated_at: bundle?.score_updated_at || null,
    odds_updated_at: bundle?.odds_updated_at || null,
    fields: { score: false, odds: false },
    upstream: 'inplay-migrate',
    scores,
    prices,
    score_failures: null,
    odds_failures: null,
    process_log: [`[inplay-tick] inplay=${matchCount}`, ...refreshLogs].join('\n'),
    admitted_live_from_full: admitLive?.admitted || 0,
    migrated_prematch_to_inplay: migratePre.moved || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
    pm_settled_marked: pmSettle.settled || 0,
    phase_marks: phaseMarks,
    inplay_matches: bundle?.live?.matches?.length || 0,
    betting,
  };
}

module.exports = { runInplayTick, refreshInplayOddsTick, stampInplayRefreshTimes };
