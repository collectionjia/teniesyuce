const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisInplayCache = require('../services/tennisInplayCache');
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

/** 仅保留 collect_live 写入的 live.matches，丢弃 scheduled 等其他来源 */
function sanitizeCollectLiveBundle(bundle) {
  if (!bundle) return null;
  const liveMatches = Array.isArray(bundle.live?.matches) ? bundle.live.matches : [];
  const liveGroup = bundle.live || {};
  return {
    ok: true,
    sport: 'tennis',
    date: bundle.date,
    fetched_at: bundle.fetched_at,
    filter: bundle.filter || bundle.dataFilter || 'collect-live',
    dataFilter: bundle.dataFilter || bundle.filter || 'collect-live',
    source: bundle.source || 'tennis-collect-live',
    dataSource: bundle.dataSource || bundle.collectScript || 'collect_live',
    collectScript: bundle.collectScript || 'collect_live',
    upstream: bundle.upstream || 'ipwo',
    scheduled: {
      tournaments: [],
      tournamentCount: 0,
      eventCount: 0,
    },
    live: {
      matches: liveMatches,
      tournaments: liveGroup.tournaments || [],
      tournamentCount: liveGroup.tournamentCount ?? 0,
      eventCount: liveMatches.length,
    },
    rankingsByPlayer: bundle.rankingsByPlayer || {},
    oddsByEvent: bundle.oddsByEvent || {},
    polymarketByEvent: bundle.polymarketByEvent || {},
    eloByEvent: bundle.eloByEvent || {},
    theOddsApiByEvent: bundle.theOddsApiByEvent || {},
    birthYearByPlayer: bundle.birthYearByPlayer || {},
    requests: bundle.requests,
    timing: bundle.timing,
    events: liveMatches.length,
    serverTime: bundle.serverTime || Math.floor(Date.now() / 1000),
    filter_conditions: bundle.filter_conditions,
    update: bundle.update,
    message: bundle.message || `collect_live · ${liveMatches.length} 场`,
  };
}

/** collect_live 尚未写入 Redis 时的空包（200，非 503） */
function emptyInplayBundle() {
  return {
    ok: true,
    empty: true,
    sport: 'tennis',
    source: 'tennis-collect-live',
    dataSource: 'collect_live',
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
    rankingsByPlayer: {},
    oddsByEvent: {},
    polymarketByEvent: {},
    events: 0,
    serverTime: Math.floor(Date.now() / 1000),
    message: '暂无数据',
    update: { message: '暂无数据 · 请先运行 collect_live.py' },
  };
}

/** 盘中采集数据（collect_live → tennis:bundle:inplay），仅管理员可访问 */
router.get('/today', auth(['admin']), async (_req, res) => {
  try {
    const raw = await tennisInplayCache.getBundle();
    if (!raw) {
      return res.json({ ...emptyInplayBundle(), member: true });
    }
    const full = sanitizeCollectLiveBundle(raw);
    res.json({ ...full, member: true });
  } catch (err) {
    console.error('[tennis-inplay/today]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load tennis inplay data',
    });
  }
});

router.post('/trade/batch', auth(['admin']), requireWallet, async (req, res) => {
  try {
    const { orders, amountUsd } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.user.id, {
      orders,
      amountUsd,
      product: 'tennis-inplay',
    });
    res.json(result);
  } catch (e) {
    console.error('[tennis-inplay/trade/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

router.post('/trade/sell', auth(['admin']), requireWallet, async (req, res) => {
  try {
    const { eventId, side, shares } = req.body || {};
    const result = await tennisTrade.placeSellOrder(req.user.id, {
      eventId,
      side,
      shares,
      product: 'tennis-inplay',
    });
    res.json(result);
  } catch (e) {
    console.error('[tennis-inplay/trade/sell]', e);
    res.status(400).json({ ok: false, error: e.message || '止损平仓失败' });
  }
});

module.exports = router;
