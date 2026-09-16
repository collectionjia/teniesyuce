/**
 * 盘中 tick：直连 Polymarket 刷价 + 迁桶；可接纳已有 slug 的新价
 */
const tennisInplayCache = require('./tennisInplayCache');
const tennisPolymarket = require('./tennisPolymarket');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisEngines = require('./tennisEngines');

async function runInplayTick() {
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
  // 比分：依赖迁桶/准入（盘中包内比分随全量/live 刷新）；字段关闭时仍迁桶，仅标记
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
    fields: { score: wantScore, odds: wantOdds },
    prices,
    migrated_prematch_to_inplay: migratePre.moved || 0,
    admitted_live_from_full: admitLive.admitted || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
    betting,
  };
}

module.exports = { runInplayTick };
