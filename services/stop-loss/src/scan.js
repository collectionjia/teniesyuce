/**
 * 止损扫描：仅 inplay 进行中 + open 持仓 → 评估 stopRules → 全平
 */
const { svc } = require('./lib/serverBridge');
const { assertBettingEnabled, getBettingConfig } = require('./lib/engineGate');
const { getOpenOrders, filterInplayOpen, bundleFreshness, resolveUserId } = require('./openOrders');

async function scan(body = {}) {
  const gate = await assertBettingEnabled();
  if (!gate.ok) {
    return { skipped: true, message: gate.reason };
  }

  const cfg = gate.cfg || (await getBettingConfig());
  const { uid, orders: allOpen } = await getOpenOrders();
  if (!uid) {
    return { skipped: true, message: 'no engine user (betting.userAccount / userId)' };
  }

  const inplayCache = svc('tennisInplayCache');
  const inplayBundle = await inplayCache.getBundle();
  const inplayOpen = filterInplayOpen(allOpen, inplayBundle);

  if (!inplayOpen.length) {
    return {
      skipped: true,
      message: 'no inplay open orders',
      metrics: { openOrders: 0, triggered: 0, closed: 0, errors: [] },
    };
  }

  const freshness = bundleFreshness(inplayBundle);
  const errors = [];
  if (freshness.stale) {
    errors.push({
      type: 'stale_data',
      message: `inplay bundle age ${freshness.ageSec}s > ${process.env.STOP_LOSS_MAX_DATA_AGE_SEC || 60}s`,
      tick_at: freshness.tick_at,
    });
  }

  const tennisBettingEngine = svc('tennisBettingEngine');
  const amountUsd = Number(body.amountUsd ?? cfg.betting?.amountUsd ?? 1) || 1;

  const r = await tennisBettingEngine.runBettingPass({
    mode: 'stop',
    onlyBucket: 'inplay',
    onlyGroupIndex: body.groupIndex != null ? Number(body.groupIndex) : null,
    onlyStrategyKey: body.strategyKey || null,
    amountUsd,
    userId: body.userId ?? uid,
  });

  if (r?.skipped) {
    return {
      skipped: true,
      message: r.reason || 'stop pass skipped',
      metrics: {
        openOrders: inplayOpen.length,
        triggered: 0,
        closed: 0,
        freshness,
        errors,
      },
    };
  }

  const closed = Number(r?.sold ?? 0);
  return {
    message: 'stop-loss scan done',
    metrics: {
      openOrders: inplayOpen.length,
      triggered: closed,
      closed,
      sold: closed,
      freshness,
      errors,
      engine: {
        ok: r?.ok,
        buckets: r?.buckets,
        mode: r?.mode,
      },
    },
  };
}

module.exports = { scan };
