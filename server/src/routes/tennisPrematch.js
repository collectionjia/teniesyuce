const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisPrematchCache = require('../services/tennisPrematchCache');
const btcWallet = require('../services/btcWallet');
const tennisTrade = require('../services/tennisTrade');

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
    res.json({ ...full, member: true, source: full.source || 'redis-prematch' });
  } catch (err) {
    console.error('[tennis-prematch/today]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load tennis prematch data',
    });
  }
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
    console.error('[tennis-prematch/trade/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

module.exports = router;
