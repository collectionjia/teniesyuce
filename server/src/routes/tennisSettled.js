const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tennisPmResults = require('../services/tennisPmResults');
const tennisSettledStats = require('../services/tennisSettledStats');
const { bundleWithOptionalCondition } = require('../services/tennisTodayQuery');

const router = Router();

function emptySettledBundle(date) {
  return {
    ok: true,
    empty: true,
    sport: 'tennis',
    source: 'mysql-tennis_pm_results',
    dataSource: 'tennis_pm_results',
    date: date || 'all',
    availableDates: [],
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: { matches: [], tournaments: [], tournamentCount: 0, eventCount: 0 },
    rankingsByPlayer: {},
    oddsByEvent: {},
    polymarketByEvent: {},
    events: 0,
    serverTime: Math.floor(Date.now() / 1000),
    message: '暂无盘后数据',
    update: { message: 'tennis_pm_results 暂无完赛记录' },
  };
}

router.get('/today', async (req, res) => {
  try {
    const rawDate = req.query?.date != null ? String(req.query.date).trim() : '';
    const date = rawDate === '' || rawDate === 'all' ? null : rawDate;
    let full = await tennisPmResults.listSettledBundle({ date });
    if (!full || full.empty) {
      const empty = emptySettledBundle(date || 'all');
      empty.availableDates = full?.availableDates || [];
      return res.json({ ...empty, member: true });
    }
    full = await bundleWithOptionalCondition(req, 'settled', full);
    res.json({ ...full, member: true, source: full.source || 'mysql-tennis_pm_results' });
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
    const bundle = await tennisPmResults.listSettledBundle({
      date: dateKey && dateKey !== 'all' ? dateKey : null,
    });
    const stats = await tennisSettledStats.computeSettledStats(req.user.id, { dateKey, bundle });
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
