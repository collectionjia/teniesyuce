/**
 * 盘中 tick：直连 Polymarket 刷价 + 迁桶；可接纳已有 slug 的新价
 */
const tennisInplayCache = require('./tennisInplayCache');
const tennisPolymarket = require('./tennisPolymarket');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisEngines = require('./tennisEngines');

async function runInplayTick() {
  const cfg = await tennisEngines.getConfig();
  if (cfg.collect?.enabled === false) {
    return { ok: false, skipped: true, reason: 'collect engine disabled' };
  }
  if (cfg.collect?.inplay_tick_enabled === false) {
    return { ok: false, skipped: true, reason: 'tick disabled' };
  }

  const migratePre = await tennisThreeBuckets.migratePrematchByStartTime();
  const admitLive = await tennisThreeBuckets.admitLiveFromFull();
  let bundle = await tennisInplayCache.getBundle();
  let prices = { updated: 0, failed: 0 };
  if (bundle) {
    prices = await tennisPolymarket.refreshPolymarketPrices(bundle);
    bundle.tick_at = new Date().toISOString();
    bundle.fetched_at = bundle.tick_at;
    await tennisInplayCache.setCachedBundle(bundle);
  }
  const migrateEnd = await tennisThreeBuckets.migrateInplayEnded();

  let betting = null;
  try {
    const tennisBettingEngine = require('./tennisBettingEngine');
    betting = await tennisBettingEngine.runBettingPass({});
  } catch (e) {
    betting = { ok: false, error: e.message };
  }

  return {
    ok: true,
    tick_at: new Date().toISOString(),
    prices,
    migrated_prematch_to_inplay: migratePre.moved || 0,
    admitted_live_from_full: admitLive.admitted || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
    betting,
  };
}

module.exports = { runInplayTick };
