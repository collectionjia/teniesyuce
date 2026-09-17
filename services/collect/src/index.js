const path = require('path');
require('dotenv').config({
  path: process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.resolve(__dirname, '..', '.env'),
});

const express = require('express');
const { internalAuth } = require('../../_lib/internalAuth');
const collectRunner = require('./collectRunner');
const { runFull } = require('./runFull');
const { runInplayPartial } = require('./inplayPartial');

const app = express();
const PORT = Number(process.env.PORT || 9101);

/** sport -> { full, partial } 互斥 */
const locks = new Map();

function getLocks(sport) {
  const key = sport || 'tennis';
  if (!locks.has(key)) {
    locks.set(key, { full: false, partial: false, lastFull: null, lastPartial: null });
  }
  return locks.get(key);
}

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'collect',
    phase: 'P2',
    collectScript: collectRunner.getCollectScript?.() || null,
    collectRunning: collectRunner.isRunning?.() || false,
  });
});

app.get('/internal/collect/sports', internalAuth, (_req, res) => {
  res.json({
    ok: true,
    sports: [{ sport: 'tennis', enabled: true, phase: 'P2' }],
  });
});

app.get('/internal/collect/status', internalAuth, (req, res) => {
  const sport = req.query.sport || 'tennis';
  const lk = getLocks(sport);
  const st = collectRunner.statusPayload?.() || {};
  res.json({
    ok: true,
    sport,
    running: {
      full: lk.full || collectRunner.isRunning?.() || false,
      partial: lk.partial,
      live: collectRunner.isLiveRunning?.() || false,
    },
    lastFull: lk.lastFull,
    lastPartial: lk.lastPartial,
    collect: st,
  });
});

app.post('/internal/collect/full', internalAuth, async (req, res) => {
  const sport = String(req.body?.sport || 'tennis').toLowerCase();
  const lk = getLocks(sport);
  if (lk.full) {
    return res.json({ ok: true, skipped: true, message: 'full collect already running for sport' });
  }
  lk.full = true;
  try {
    const result = await runFull(req.body || {});
    lk.lastFull = { at: new Date().toISOString(), ...result };
    if (result.skipped) {
      return res.json({ ok: true, skipped: true, message: result.message, metrics: result.metrics || null });
    }
    res.json({ ok: true, message: result.message, metrics: result.metrics || null });
  } catch (e) {
    console.error('[collect] full', e.message);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  } finally {
    lk.full = false;
  }
});

app.post('/internal/collect/partial', internalAuth, async (req, res) => {
  const sport = String(req.body?.sport || 'tennis').toLowerCase();
  const lk = getLocks(sport);
  if (lk.partial) {
    return res.json({ ok: true, skipped: true, message: 'partial collect already running for sport' });
  }
  lk.partial = true;
  try {
    const result = await runInplayPartial();
    lk.lastPartial = { at: new Date().toISOString(), ...result };
    if (result.skipped) {
      return res.json({ ok: true, skipped: true, message: result.message, metrics: result });
    }
    res.json({ ok: true, message: result.message || 'partial done', metrics: result });
  } catch (e) {
    console.error('[collect] partial', e.message);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  } finally {
    lk.partial = false;
  }
});

app.listen(PORT, () => {
  console.log(`[collect] listening on :${PORT} (P2)`);
});
