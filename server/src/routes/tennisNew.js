const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisNewCache = require('../services/tennisNewCache');
const tennisNewFromMonitor = require('../services/tennisNewFromMonitor');
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

router.get('/today', auth(), async (_req, res) => {
  try {
    const full = await tennisNewCache.getBundle();
    if (!full) {
      return res.status(503).json({
        ok: false,
        error: '新网球列表数据尚未就绪，请稍后再试',
      });
    }
    res.json({ ...full, member: true, source: 'redis-new' });
  } catch (err) {
    console.error('[tennis-new/today]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load new tennis data',
    });
  }
});

router.post('/cache/refresh', auth(['admin']), async (_req, res) => {
  try {
    const bundle = await tennisNewFromMonitor.refreshNewBundleFromMonitor();
    res.json({
      ok: true,
      events: bundle.events,
      date: bundle.date,
      fetched_at: bundle.fetched_at,
      live: bundle.live?.eventCount ?? 0,
      source: 'sofascore-monitor→redis-new',
    });
  } catch (err) {
    console.error('[tennis-new/cache/refresh]', err);
    res.status(500).json({ ok: false, error: err.message || 'cache refresh failed' });
  }
});

router.post('/trade/batch', auth(), requireWallet, async (req, res) => {
  try {
    const { orders, amountUsd } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.user.id, {
      orders,
      amountUsd,
      product: 'tennis-new',
    });
    res.json(result);
  } catch (e) {
    console.error('[tennis-new/trade/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

module.exports = router;
