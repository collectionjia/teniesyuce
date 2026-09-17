const { Router } = require('express');
const tennisPrematchCache = require('../services/tennisPrematchCache');
const tennisTrade = require('../services/tennisTrade');
const tennisDataSource = require('../services/tennisDataSource');
const {
  attachUserFromEmailBody,
  resolveTradeSimulatePublic,
} = require('../services/tennisOrdersPublic');

const router = Router();

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

router.get('/today', async (_req, res) => {
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

router.post('/trade/batch', attachUserFromEmailBody, resolveTradeSimulatePublic, async (req, res) => {
  try {
    const { orders, amountUsd } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.tennisUser.id, {
      orders,
      amountUsd,
      product: 'tennis-prematch',
      simulate: !!req.tradeSimulate,
    });
    res.json({
      ...result,
      email: req.tennisUser.account,
      userId: req.tennisUser.id,
      product: 'tennis-prematch',
    });
  } catch (e) {
    console.error('[tennis-prematch/trade/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

router.post('/trade/sell', attachUserFromEmailBody, resolveTradeSimulatePublic, async (req, res) => {
  try {
    const { eventId, side, shares } = req.body || {};
    const result = await tennisTrade.placeSellOrder(req.tennisUser.id, {
      eventId,
      side,
      shares,
      product: 'tennis-prematch',
      simulate: !!req.tradeSimulate,
    });
    res.json({
      ...result,
      email: req.tennisUser.account,
      userId: req.tennisUser.id,
      product: 'tennis-prematch',
    });
  } catch (e) {
    console.error('[tennis-prematch/trade/sell]', e);
    res.status(400).json({ ok: false, error: e.message || '止损平仓失败' });
  }
});

module.exports = router;
