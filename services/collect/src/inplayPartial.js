/**
 * 部分采集：盘中 tick（网球比分 + Polymarket 赔率；投注由 scheduler → betting 负责）
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

  // 与 server tennisInplayTick 同源：比分(tennis) + 赔率(PM) 写入盘中包（投注由 betting 服务负责）
  const tennisInplayTick = svc('tennisInplayTick');
  if (tennisInplayTick?.runInplayTick) {
    const r = await tennisInplayTick.runInplayTick({ skipBetting: true });
    if (r && typeof r === 'object') {
      return {
        ...r,
        message: r.ok === false ? (r.reason || 'inplay tick failed') : 'inplay partial done',
      };
    }
    return r;
  }

  // 回退：旧逻辑（仅 PM + 迁桶）
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
    const tickAt = new Date().toISOString();
    bundle.tick_at = tickAt;
    bundle.fetched_at = tickAt;
    bundle.odds_updated_at = tickAt;
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
    odds_failures: prices.failures || null,
    process_log: [
      '[inplayPartial] fallback path (tennisInplayTick unavailable)',
      wantScore ? '[score] skipped on fallback' : '[score] off',
      prices.process_log || `[odds] updated=${prices.updated || 0} failed=${prices.failed || 0}`,
    ].join('\n'),
    migrated_prematch_to_inplay: migratePre.moved || 0,
    admitted_live_from_full: admitLive.admitted || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
  };
}

module.exports = { runInplayPartial };
