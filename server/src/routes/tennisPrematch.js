const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisPrematchCache = require('../services/tennisPrematchCache');
const btcWallet = require('../services/btcWallet');
const tennisTrade = require('../services/tennisTrade');
const tennisDataSource = require('../services/tennisDataSource');

const router = Router();

async function requireWallet(req, res, next) {
  try {
    const ok = await btcWallet.userHasWalletAccess(req.user);
    if (!ok) return res.status(403).json({ error: '未开通 BTC 虚拟投注权限，无法批量下单' });
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '权限校验失败' });
  }
}

async function resolveTradeSimulate(req, res, next) {
  try {
    // 虚拟采集(docks500)强制模拟；真实采集时由前端「模拟投注」开关决定
    const forceSim = await tennisDataSource.shouldSimulateTrades();
    const wantSim = forceSim || !!(req.body && (req.body.simulate === true || req.body.simulate === 1 || req.body.simulate === '1'));
    req.tradeSimulate = wantSim;
    if (req.tradeSimulate) return next();
    return requireWallet(req, res, next);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '交易模式校验失败' });
  }
}

function emptyPrematchBundle() {
  return {
    ok: true,
    empty: true,
    sport: 'tennis',
    source: 'tennis-prematch',
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
    rankingsByPlayer: {},
    oddsByEvent: {},
    polymarketByEvent: {},
    events: 0,
    serverTime: Math.floor(Date.now() / 1000),
    message: '暂无盘前数据',
    update: { message: '暂无数据 · 等待全量采集写入 tennis:bundle:prematch' },
  };
}

router.get('/today', auth(), async (_req, res) => {
  try {
    let full = await tennisPrematchCache.getBundle();
    if (!full) {
      return res.json({ ...emptyPrematchBundle(), member: true });
    }
    const tennisConditionApply = require('../services/tennisConditionApply');
    full = await tennisConditionApply.maybeApplyCondition('prematch', full);
    const tennisDataSource = require('../services/tennisDataSource');
    res.json({
      ...full,
      member: true,
      source: full.source || 'redis-prematch',
      tradeSimulate: await tennisDataSource.shouldSimulateTrades(),
    });
  } catch (err) {
    console.error('[tennis-prematch/today]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load tennis prematch data',
    });
  }
});

router.post('/trade/batch', auth(), resolveTradeSimulate, async (req, res) => {
  try {
    const { orders, amountUsd } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.user.id, {
      orders,
      amountUsd,
      product: 'tennis-prematch',
      simulate: !!req.tradeSimulate,
    });
    res.json(result);
  } catch (e) {
    console.error('[tennis-prematch/trade/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

router.post('/trade/sell', auth(), resolveTradeSimulate, async (req, res) => {
  try {
    const { eventId, side, shares } = req.body || {};
    const result = await tennisTrade.placeSellOrder(req.user.id, {
      eventId,
      side,
      shares,
      product: 'tennis-prematch',
      simulate: !!req.tradeSimulate,
    });
    res.json(result);
  } catch (e) {
    console.error('[tennis-prematch/trade/sell]', e);
    res.status(400).json({ ok: false, error: e.message || '止损平仓失败' });
  }
});

module.exports = router;
