const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisPrematchCache = require('../services/tennisPrematchCache');
const btcWallet = require('../services/btcWallet');
const tennisTrade = require('../services/tennisTrade');

/** @deprecated 转发盘前：range → tennis-prematch */
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

function emptyBundle() {
  return {
    ok: true,
    empty: true,
    sport: 'tennis',
    source: 'redis-prematch-via-range',
    deprecated: true,
    forward: 'tennis-prematch',
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
    rankingsByPlayer: {},
    oddsByEvent: {},
    polymarketByEvent: {},
    events: 0,
    serverTime: Math.floor(Date.now() / 1000),
    message: '已转发盘前桶（旧 tennis-range）',
  };
}

router.get('/today', auth(), async (_req, res) => {
  try {
    const full = await tennisPrematchCache.getBundle();
    if (!full) return res.json({ ...emptyBundle(), member: true });
    res.json({
      ...full,
      member: true,
      deprecated: true,
      forward: 'tennis-prematch',
      source: full.source || 'redis-prematch-via-range',
    });
  } catch (err) {
    console.error('[tennis-range/today→prematch]', err);
    res.status(500).json({ ok: false, error: err.message || 'failed' });
  }
});

router.post('/cache/refresh', auth(['admin']), async (_req, res) => {
  res.json({
    ok: true,
    deprecated: true,
    message: '请改用全量采集写入 tennis:bundle:prematch',
  });
});

router.post('/trade/batch', auth(), requireWallet, async (req, res) => {
  try {
    const { orders, amountUsd } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.user.id, {
      orders,
      amountUsd,
      product: 'tennis-prematch',
    });
    res.json(result);
  } catch (e) {
    console.error('[tennis-range/trade/batch→prematch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

module.exports = router;
