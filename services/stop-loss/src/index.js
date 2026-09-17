const path = require('path');
require('dotenv').config({
  path: process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.resolve(__dirname, '..', '.env'),
});

const express = require('express');
const { internalAuth } = require('../../_lib/internalAuth');
const { scan } = require('./scan');
const { getOpenOrders, filterInplayOpen } = require('./openOrders');
const { svc } = require('./lib/serverBridge');

const app = express();
const PORT = Number(process.env.PORT || 9104);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'stop-loss', phase: 'P5' });
});

app.post('/internal/stop-loss/scan', internalAuth, async (req, res) => {
  try {
    const result = await scan(req.body || {});
    if (result.skipped) {
      return res.json({
        ok: true,
        skipped: true,
        message: result.message,
        metrics: result.metrics || null,
      });
    }
    const m = result.metrics || {};
    res.json({
      ok: true,
      message: result.message,
      openOrders: m.openOrders ?? 0,
      triggered: m.triggered ?? 0,
      closed: m.closed ?? 0,
      errors: m.errors ?? [],
      metrics: m,
    });
  } catch (e) {
    console.error('[stop-loss] scan', e.message);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/internal/stop-loss/status', internalAuth, async (_req, res) => {
  try {
    const { orders } = await getOpenOrders();
    const inplayBundle = await svc('tennisInplayCache').getBundle();
    const inplayOpen = filterInplayOpen(orders, inplayBundle);
    res.json({
      ok: true,
      openOrders: inplayOpen.length,
      inplayEvents: (inplayBundle?.live?.matches || []).length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[stop-loss] listening on :${PORT} (P5)`);
});
