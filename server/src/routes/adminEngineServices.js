/**
 * 管理后台 · 五引擎服务代理（JWT admin）
 * 前端页面统一走 /api/admin/engines/* → services/*
 */
const express = require('express');
const { auth } = require('../middleware/auth');
const svc = require('../services/engineServicesClient');

const router = express.Router();
router.use(auth(['admin']));

router.get('/overview', async (_req, res) => {
  try {
    const data = await svc.fetchOverview();
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.get('/collect/status', async (req, res) => {
  try {
    const data = await svc.collectStatus({ sport: req.query.sport || 'tennis' });
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.get('/collect/background', async (_req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const sofaScoreBackground = require('../services/sofaScoreBackground');
    const polyOddsBackground = require('../services/polyOddsBackground');
    res.json({
      ok: true,
      settings: tennisEngines.getCollectBackgroundSettings(),
      score: sofaScoreBackground.statusPayload(),
      odds: polyOddsBackground.statusPayload(),
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/collect/background/clear-logs', async (req, res) => {
  try {
    const kind = String(req.body?.kind || 'all').toLowerCase();
    const sofaScoreBackground = require('../services/sofaScoreBackground');
    const polyOddsBackground = require('../services/polyOddsBackground');
    if (kind === 'score' || kind === 'all') sofaScoreBackground.clearLogs();
    if (kind === 'odds' || kind === 'all') polyOddsBackground.clearLogs();
    res.json({ ok: true, kind });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/collect/full', async (req, res) => {
  try {
    const body = req.body || {};
    const data = await svc.collectFull({
      sport: body.sport || 'tennis',
      top100: body.top100 !== false && body.all !== true,
      ...body,
    });
    if (data?.skipped) {
      return res.status(409).json({ ok: false, error: data.message || 'collect skipped', ...data });
    }
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/collect/partial', async (req, res) => {
  try {
    const data = await svc.collectPartial(req.body || {});
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/rules/evaluate', async (req, res) => {
  try {
    const data = await svc.rulesEvaluate(req.body || {});
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.get('/rules/matched', async (req, res) => {
  try {
    const data = await svc.rulesMatched({
      bucket: req.query.bucket || 'prematch',
      sport: req.query.sport || 'tennis',
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/betting/scan', async (req, res) => {
  try {
    const data = await svc.bettingScan(req.body || {});
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.get('/betting/orders/open', async (_req, res) => {
  try {
    const data = await svc.bettingOpenOrders();
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/stop-loss/scan', async (req, res) => {
  try {
    const data = await svc.stopLossScan(req.body || {});
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.get('/stop-loss/status', async (_req, res) => {
  try {
    const data = await svc.stopLossStatus();
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
