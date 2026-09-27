const { Router } = require('express');
const { auth, optionalAuth } = require('../middleware/auth');
const tennisInplayCache = require('../services/tennisInplayCache');
const tennisTrade = require('../services/tennisTrade');
const tennisDataSource = require('../services/tennisDataSource');
const {
  attachUserFromEmailBody,
  resolveTradeSimulatePublic,
} = require('../services/tennisOrdersPublic');
const { bundleWithOptionalCondition, wantApplyCondition } = require('../services/tennisTodayQuery');
const {
  lookupMatchByEventId,
  buildPublicMatchPayload,
  findEventInBundle,
  listInplayEligibleEvents,
  enrichEvent,
} = require('../services/tennisInplayMatchQuery');
const tennisPolymarket = require('../services/tennisPolymarket');

/** 详情页轮询：仅拉 CLOB 赔率；比分始终读 Redis（后台采集写入） */
function wantPolyRefresh(req) {
  const v = String(req.query?.refresh ?? '').trim().toLowerCase();
  return v === 'poly' || v === 'clob' || v === '1' || v === 'true';
}

const router = Router();

function isBoardPushInplay(bundle) {
  const ds = String(bundle?.dataSource || bundle?.source || '').toLowerCase();
  return ds.includes('board-push') || ds.includes('tennis-live-board');
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
    upstream: bundle.upstream || bundle.dataSource || 'sofascore',
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
    tick_at: bundle.tick_at || null,
    score_updated_at: bundle.score_updated_at || null,
    odds_updated_at: bundle.odds_updated_at || null,
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

/** 单场：开赛时间已过即可返回；inPlay=true 才表示真正比赛中（无需 JWT） */
router.get('/match/:eventId', async (req, res) => {
  try {
    const eventId = String(req.params.eventId || req.query?.eventId || '').trim();
    if (!eventId) {
      return res.status(400).json({ ok: false, error: 'eventId 不能为空' });
    }
    const serverTime = Math.floor(Date.now() / 1000);
    const row = await lookupMatchByEventId(eventId);
    if (!row) {
      return res.json({
        ok: true,
        found: false,
        empty: true,
        sport: 'tennis',
        product: 'tennis-inplay',
        eventId,
        inPlay: false,
        pastStart: false,
        message: '未找到该比赛，或未到开赛时间',
        serverTime,
      });
    }
    if (wantApplyCondition(req) && row.inPlay) {
      const wrapped = await bundleWithOptionalCondition(req, 'inplay', {
        ...sanitizeCollectLiveBundle(row.bundle),
        live: { matches: [row.event], eventCount: 1 },
      });
      const filtered = findEventInBundle(wrapped, eventId);
      const tagged = filtered ? enrichEvent(filtered, serverTime) : null;
      if (!tagged || !tagged.inPlay) {
        return res.json({
          ok: true,
          found: false,
          empty: true,
          sport: 'tennis',
          product: 'tennis-inplay',
          eventId,
          inPlay: false,
          pastStart: row.pastStart,
          message: '该比赛未通过条件筛选或不在进行中',
          serverTime,
        });
      }
      row.event = tagged;
      row.inPlay = tagged.inPlay;
      row.pastStart = tagged.pastStart;
    }
    let oddsRefreshedAt = null;
    if (wantPolyRefresh(req) && (row.inPlay || row.pastStart)) {
      const eid = String(eventId);
      const poly = row.bundle?.polymarketByEvent?.[eid]
        || row.bundle?.polymarketByEvent?.[Number(eid)]
        || null;
      if (poly?.slug || poly?.url) {
        try {
          const pr = await tennisPolymarket.refreshInplayOddsByEventId(eventId, { clobOnly: true });
          if (pr?.odds_updated_at) oddsRefreshedAt = pr.odds_updated_at;
        } catch (err) {
          console.warn('[tennis-inplay/match] poly clob refresh', eventId, err.message || err);
        }
      }
    }
    const latest = await lookupMatchByEventId(eventId);
    if (latest) row = latest;
    res.json({
      ...buildPublicMatchPayload(row, { odds_updated_at: oddsRefreshedAt }),
      member: true,
      tradeSimulate: await tennisDataSource.shouldSimulateTrades(),
    });
  } catch (err) {
    console.error('[tennis-inplay/match]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load tennis inplay match',
    });
  }
});

/** 盘中列表：仅 inPlay=true（Redis 源状态为进行中） */
router.get('/today', async (req, res) => {
  try {
    const raw = await tennisInplayCache.getBundle();
    const { events: eligible, serverTime } = await listInplayEligibleEvents();
    if (!raw && !eligible.length) {
      let bettingEntry = null;
      try {
        const tennisEngines = require('../services/tennisEngines');
        const cfg = await tennisEngines.getConfigPreferRedis();
        bettingEntry = tennisEngines.normalizeInplayBettingEntry(cfg?.betting?.buckets?.inplay?.entry);
      } catch (_) { /* ignore */ }
      return res.json({
        ...emptyInplayBundle(),
        member: true,
        bettingEntry,
        tradeSimulate: await tennisDataSource.shouldSimulateTrades(),
      });
    }
    let full = raw ? sanitizeCollectLiveBundle(raw) : emptyInplayBundle();
    const rawLive = Array.isArray(full.live?.matches) ? full.live.matches : [];
    let matchList = eligible;
    if (isBoardPushInplay(full) && rawLive.length) {
      const byId = new Map();
      for (const m of rawLive) {
        if (m?.id == null) continue;
        const id = String(m.id);
        const poly = full.polymarketByEvent?.[id] || full.polymarketByEvent?.[m.id] || null;
        byId.set(id, enrichEvent(m, serverTime, poly));
      }
      for (const m of eligible) {
        if (m?.id == null) continue;
        byId.set(String(m.id), m);
      }
      matchList = [...byId.values()];
    }
    full.live = {
      ...(full.live || {}),
      matches: matchList,
      eventCount: matchList.length,
    };
    full.events = matchList.length;
    full.serverTime = serverTime;
    full.inPlayCount = matchList.filter((e) => e.inPlay).length;
    full = await bundleWithOptionalCondition(req, 'inplay', full);
    if (Array.isArray(full.live?.matches)) {
      full.live.matches = full.live.matches.map((m) => {
        if (m?.pastStart != null && m?.inPlay != null) return m;
        const id = String(m.id);
        const poly = full.polymarketByEvent?.[id] || full.polymarketByEvent?.[m.id] || null;
        return enrichEvent(m, serverTime, poly);
      });
      full.live.eventCount = full.live.matches.length;
      full.events = full.live.matches.length;
      full.inPlayCount = full.live.matches.filter((e) => e.inPlay).length;
      try {
        require('../services/tennisPmResults').queuePmSettled(full.live.matches, full.rankingsByPlayer);
      } catch (e) {
        console.warn('[tennis-inplay/today] pm results', e.message);
      }
    }
    let bettingEntry = null;
    try {
      const tennisEngines = require('../services/tennisEngines');
      const cfg = await tennisEngines.getConfigPreferRedis();
      bettingEntry = tennisEngines.normalizeInplayBettingEntry(cfg?.betting?.buckets?.inplay?.entry);
    } catch (e) {
      console.warn('[tennis-inplay/today] bettingEntry', e.message);
    }
    res.json({ ...full, member: true, bettingEntry, tradeSimulate: await tennisDataSource.shouldSimulateTrades() });
  } catch (err) {
    console.error('[tennis-inplay/today]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load tennis inplay data',
    });
  }
});

router.post('/trade/batch', optionalAuth(), attachUserFromEmailBody, resolveTradeSimulatePublic, async (req, res) => {
  try {
    const { orders, amountUsd, orderType, limitPrice, limitBuyPrice, shares } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.tennisUser.id, {
      orders,
      amountUsd,
      product: 'tennis-inplay',
      simulate: !!req.tradeSimulate,
      orderType,
      limitPrice: limitBuyPrice ?? limitPrice,
      limitBuyPrice: limitBuyPrice ?? limitPrice,
      shares,
      wallet: req.walletOverride,
    });
    res.json({
      ...result,
      email: req.tennisUser.account,
      userId: req.tennisUser.id,
      product: 'tennis-inplay',
    });
  } catch (e) {
    console.error('[tennis-inplay/trade/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

router.post('/trade/sell', optionalAuth(), attachUserFromEmailBody, resolveTradeSimulatePublic, async (req, res) => {
  try {
    const { eventId, side, shares, orderType, limitSellPrice, limitPrice } = req.body || {};
    const result = await tennisTrade.placeSellOrder(req.tennisUser.id, {
      eventId,
      side,
      shares,
      product: 'tennis-inplay',
      simulate: !!req.tradeSimulate,
      orderType,
      limitSellPrice,
      limitPrice: limitSellPrice ?? limitPrice,
      wallet: req.walletOverride,
    });
    res.json({
      ...result,
      email: req.tennisUser.account,
      userId: req.tennisUser.id,
      product: 'tennis-inplay',
    });
  } catch (e) {
    console.error('[tennis-inplay/trade/sell]', e);
    res.status(400).json({ ok: false, error: e.message || '止损平仓失败' });
  }
});

router.post('/tick', auth(['admin']), async (req, res) => {
  try {
    const engineServices = require('../services/engineServicesClient');
    const result = await engineServices.collectPartial(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[tennis-inplay/tick]', e);
    res.status(e.status || 500).json({ ok: false, error: e.message || 'tick failed' });
  }
});

module.exports = router;
