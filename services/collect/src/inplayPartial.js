/**
 * 部分采集：盘中迁桶（inplay_tick）或 Top100 高频赔率（top100_hf）
 */
const { svc } = require('./lib/serverBridge');
const { assertCollectEnabled } = require('./lib/engineGate');

async function runInplayPartial(body = {}) {
  const gate = await assertCollectEnabled();
  if (!gate.ok) {
    return { skipped: true, message: gate.reason };
  }

  const cfg = gate.cfg || {};
  const jobType = String(body.jobType || '').trim();
  const isHf = jobType === 'collect.top100_hf';

  if (!isHf && cfg.collect?.inplay_tick_enabled === false) {
    return { skipped: true, message: 'inplay_tick disabled in collect config' };
  }

  const tennisDataSource = svc('tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return { skipped: true, message: '虚拟(txt)模式跳过 tick / Polymarket 采集' };
  }

  const tennisInplayTick = svc('tennisInplayTick');
  if (isHf && tennisInplayTick?.refreshInplayOddsTick) {
    const r = await tennisInplayTick.refreshInplayOddsTick();
    return {
      ...r,
      message: r.ok === false ? (r.reason || 'top100_hf odds failed') : 'top100_hf odds done',
    };
  }
  if (tennisInplayTick?.runInplayTick) {
    const r = await tennisInplayTick.runInplayTick({ skipBetting: true });
    return {
      ...r,
      message: r.ok === false ? (r.reason || 'inplay tick failed') : 'inplay partial done',
    };
  }

  const tennisThreeBuckets = svc('tennisThreeBuckets');
  const migratePre = await tennisThreeBuckets.migratePrematchByStartTime();
  const admitLive = await tennisThreeBuckets.admitLiveFromFull();
  const migrateEnd = await tennisThreeBuckets.migrateInplayEnded();

  return {
    ok: true,
    message: 'inplay partial done',
    tick_at: new Date().toISOString(),
    fields: { score: false, odds: false },
    prices: { skipped: true, reason: 'odds only via full collect / poly-odds loop' },
    process_log: '[inplayPartial] fallback migrate only',
    migrated_prematch_to_inplay: migratePre.moved || 0,
    admitted_live_from_full: admitLive.admitted || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
  };
}

module.exports = { runInplayPartial };
