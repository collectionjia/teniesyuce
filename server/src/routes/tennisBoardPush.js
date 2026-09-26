/**
 * 本地 tennis-live-board 推送全量/高频包到线上 Redis。
 * 鉴权：Authorization Bearer / X-Board-Token / ?token= 对齐 SOFA_MONITOR_TOKEN。
 */
const express = require('express');
const tennisCache = require('../services/tennisCache');
const tennisInplayCache = require('../services/tennisInplayCache');
const tennisThreeBuckets = require('../services/tennisThreeBuckets');
const tennisRedis = require('../services/tennisRedis');

const router = express.Router();
router.use(express.json({ limit: '15mb' }));

const PUSH_TOKEN = String(
  process.env.SOFA_BOARD_PUSH_TOKEN || process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026',
).trim();

function checkToken(req) {
  if (!PUSH_TOKEN) return true;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const header = String(req.headers['x-board-token'] || '').trim();
  const query = String(req.query.token || '').trim();
  return [bearer, header, query].includes(PUSH_TOKEN);
}

function requireToken(req, res, next) {
  if (!checkToken(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

router.post('/full', requireToken, async (req, res) => {
  try {
    const bundle = req.body?.bundle || req.body;
    if (!bundle || typeof bundle !== 'object') {
      return res.status(400).json({ ok: false, error: 'missing bundle' });
    }
    bundle.ok = true;
    bundle.sport = bundle.sport || 'tennis';
    bundle.fetched_at = bundle.fetched_at || new Date().toISOString();
    bundle.source = bundle.source || 'tennis-live-board';
    bundle.dataSource = bundle.dataSource || 'board-push';
    const wrote = await tennisCache.setCachedBundle(bundle, bundle.fetched_at);
    if (!wrote) {
      return res.status(503).json({ ok: false, error: 'redis write full failed' });
    }
    let split = null;
    try {
      split = await tennisThreeBuckets.splitFullToThreeBuckets(bundle);
    } catch (err) {
      console.error('[tennis-board-push] split failed:', err.message);
    }
    try {
      tennisRedis.invalidateMemCache();
    } catch {
      /* ignore */
    }
    return res.json({
      ok: true,
      mode: 'full',
      key: 'tennis:bundle:full',
      events: bundle.events ?? (bundle.live?.matches || []).length,
      split,
      fetched_at: bundle.fetched_at,
    });
  } catch (err) {
    console.error('[tennis-board-push] full:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/live', requireToken, async (req, res) => {
  try {
    const bundle = req.body?.bundle || req.body;
    if (!bundle || typeof bundle !== 'object') {
      return res.status(400).json({ ok: false, error: 'missing bundle' });
    }
    bundle.ok = true;
    bundle.sport = bundle.sport || 'tennis';
    bundle.fetched_at = bundle.fetched_at || new Date().toISOString();
    bundle.source = bundle.source || 'tennis-live-board-live';
    bundle.dataSource = bundle.dataSource || 'board-push-live';
    const n = (bundle.live?.matches || []).length;
    const wrote = await tennisInplayCache.setCachedBundle(bundle, bundle.fetched_at);
    if (!wrote) {
      return res.status(503).json({ ok: false, error: 'redis write inplay failed' });
    }
    try {
      tennisRedis.invalidateMemCache();
    } catch {
      /* ignore */
    }
    return res.json({
      ok: true,
      mode: 'live',
      key: 'tennis:bundle:inplay',
      events: n,
      fetched_at: bundle.fetched_at,
    });
  } catch (err) {
    console.error('[tennis-board-push] live:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tennis-board-push' });
});

module.exports = router;
