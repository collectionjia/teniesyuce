const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisInplayCache = require('../services/tennisInplayCache');
const btcWallet = require('../services/btcWallet');
const tennisTrade = require('../services/tennisTrade');

/** @deprecated 转发盘中：live → tennis-inplay */
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

function sanitizeCollectLiveBundle(bundle) {
  if (!bundle) return null;
  const liveMatches = Array.isArray(bundle.live?.matches) ? bundle.live.matches : [];
  const liveGroup = bundle.live || {};
  return {
    ok: true,
    sport: 'tennis',
    date: bundle.date,
    fetched_at: bundle.fetched_at,
    deprecated: true,
    forward: 'tennis-inplay',
    source: bundle.source || 'redis-inplay-via-live',
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: {
      matches: liveMatches,
      tournaments: liveGroup.tournaments || [],
      tournamentCount: liveGroup.tournamentCount ?? 0,
      eventCount: liveMatches.length,
    },
    rankingsByPlayer: bundle.rankingsByPlayer || {},
    oddsByEvent: bundle.oddsByEvent || {},
    polymarketByEvent: bundle.polymarketByEvent || {},
    events: liveMatches.length,
    serverTime: bundle.serverTime || Math.floor(Date.now() / 1000),
    message: bundle.message || `inplay via live · ${liveMatches.length} 场`,
  };
}

router.get('/today', auth(), async (_req, res) => {
  try {
    const raw = await tennisInplayCache.getBundle();
    if (!raw) {
      return res.json({
        ok: true,
        empty: true,
        deprecated: true,
        forward: 'tennis-inplay',
        member: true,
        live: { matches: [] },
        scheduled: { tournaments: [] },
        message: '暂无盘中数据',
      });
    }
    res.json({ ...sanitizeCollectLiveBundle(raw), member: true });
  } catch (err) {
    console.error('[tennis-live/today→inplay]', err);
    res.status(500).json({ ok: false, error: err.message || 'failed' });
  }
});

router.post('/cache/refresh', auth(['admin']), async (_req, res) => {
  res.json({ ok: true, deprecated: true, message: '请改用盘中 tick / 全量采集写入 tennis:bundle:inplay' });
});

router.post('/trade/batch', auth(), requireWallet, async (req, res) => {
  try {
    const { orders, amountUsd } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.user.id, {
      orders,
      amountUsd,
      product: 'tennis-inplay',
    });
    res.json(result);
  } catch (e) {
    console.error('[tennis-live/trade/batch→inplay]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

module.exports = router;
