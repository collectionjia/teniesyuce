/**
 * 部分采集：盘中 tick（无投注；投注由 scheduler → betting 负责）
 */
const { svc } = require('./lib/serverBridge');
const { assertCollectEnabled } = require('./lib/engineGate');

async function runInplayPartial() {
  const gate = await assertCollectEnabled();
  if (!gate.ok) {
    return { skipped: true, message: gate.reason };
  }

  const cfg = gate.cfg || {};
  if (cfg.collect?.inplay_tick_enabled === false) {
    return { skipped: true, message: 'inplay_tick disabled in collect config' };
  }

  const tennisDataSource = svc('tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return { skipped: true, message: '虚拟(txt)模式跳过 tick / Polymarket 采集' };
  }

  const tennisThreeBuckets = svc('tennisThreeBuckets');
  const tennisInplayCache = svc('tennisInplayCache');
  const tennisPolymarket = svc('tennisPolymarket');

  const migratePre = await tennisThreeBuckets.migratePrematchByStartTime();
  const admitLive = await tennisThreeBuckets.admitLiveFromFull();
  let bundle = await tennisInplayCache.getBundle();
  let prices = { updated: 0, failed: 0, skipped: false };
  const fields = cfg.collect?.inplay_tick_fields || {};
  const wantOdds = fields.odds !== false;
  const wantScore = fields.score !== false;

  if (bundle && wantOdds) {
    prices = await tennisPolymarket.refreshPolymarketPrices(bundle);
    bundle.tick_at = new Date().toISOString();
    bundle.fetched_at = bundle.tick_at;
    await tennisInplayCache.setCachedBundle(bundle);
  } else if (bundle && !wantOdds) {
    prices = { updated: 0, failed: 0, skipped: true, reason: 'odds field off' };
  }

  const migrateEnd = await tennisThreeBuckets.migrateInplayEnded();

  return {
    ok: true,
    message: 'inplay partial done',
    tick_at: new Date().toISOString(),
    fields: { score: wantScore, odds: wantOdds },
    prices,
    migrated_prematch_to_inplay: migratePre.moved || 0,
    admitted_live_from_full: admitLive.admitted || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
  };
}

module.exports = { runInplayPartial };
