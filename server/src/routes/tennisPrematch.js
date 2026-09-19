const { Router } = require('express');
const tennisPrematchCache = require('../services/tennisPrematchCache');
const tennisTrade = require('../services/tennisTrade');
const tennisDataSource = require('../services/tennisDataSource');
const {
  attachUserFromEmailBody,
  resolveTradeSimulatePublic,
} = require('../services/tennisOrdersPublic');
const { bundleWithOptionalCondition } = require('../services/tennisTodayQuery');

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

router.get('/today', async (req, res) => {
  try {
    let full = await tennisPrematchCache.getBundle();
    if (!full) {
      return res.json({ ...emptyPrematchBundle(), member: true });
    }
    full = await bundleWithOptionalCondition(req, 'prematch', full);
    const tennisDataSource = require('../services/tennisDataSource');
    // 缓存包里的 serverTime 可能是采集写入时的旧值；列表用它推算「现在」会导致已开赛仍显示未开赛
    res.json({
      ...full,
      member: true,
      source: full.source || 'redis-prematch',
      serverTime: Math.floor(Date.now() / 1000),
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
    const { orders, amountUsd, orderType, limitPrice, limitBuyPrice, shares, allowAnySide } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.tennisUser.id, {
      orders,
      amountUsd,
      product: 'tennis-prematch',
      simulate: !!req.tradeSimulate,
      orderType,
      limitPrice: limitBuyPrice ?? limitPrice,
      limitBuyPrice: limitBuyPrice ?? limitPrice,
      shares,
      allowAnySide: !!allowAnySide,
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
    const { eventId, side, shares, orderType, limitSellPrice, limitPrice } = req.body || {};
    const result = await tennisTrade.placeSellOrder(req.tennisUser.id, {
      eventId,
      side,
      shares,
      product: 'tennis-prematch',
      simulate: !!req.tradeSimulate,
      orderType,
      limitSellPrice,
      limitPrice: limitSellPrice ?? limitPrice,
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
