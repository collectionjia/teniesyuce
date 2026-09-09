const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisSettledCache = require('../services/tennisSettledCache');
const tennisSettledStats = require('../services/tennisSettledStats');

const router = Router();

function emptySettledBundle() {
  return {
    ok: true,
    empty: true,
    sport: 'tennis',
    source: 'tennis-settled',
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
    rankingsByPlayer: {},
    oddsByEvent: {},
    polymarketByEvent: {},
    events: 0,
    serverTime: Math.floor(Date.now() / 1000),
    message: '暂无盘后数据',
    update: { message: '暂无数据 · 等待全量采集或 tick 迁入 tennis:bundle:settled' },
  };
}

router.get('/today', auth(), async (_req, res) => {
  try {
    let full = await tennisSettledCache.getBundle();
    if (!full) {
      return res.json({ ...emptySettledBundle(), member: true });
    }
    const tennisConditionApply = require('../services/tennisConditionApply');
    full = await tennisConditionApply.maybeApplyCondition('settled', full);
    res.json({ ...full, member: true, source: full.source || 'redis-settled' });
  } catch (err) {
    console.error('[tennis-settled/today]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load tennis settled data',
    });
  }
});

router.get('/stats', auth(), async (req, res) => {
  try {
    const dateKey = req.query?.date ? String(req.query.date) : undefined;
    const stats = await tennisSettledStats.computeSettledStats(req.user.id, { dateKey });
    res.json(stats);
  } catch (err) {
    console.error('[tennis-settled/stats]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'failed to load settled stats',
    });
  }
});

module.exports = router;
