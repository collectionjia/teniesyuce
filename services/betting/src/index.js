const path = require('path');
require('dotenv').config({
  path: process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.resolve(__dirname, '..', '.env'),
});

const express = require('express');
const { internalAuth } = require('../../_lib/internalAuth');
const { scan } = require('./scan');
const { getOpenOrders } = require('./openOrders');

const app = express();
const PORT = Number(process.env.PORT || 9103);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'betting', phase: 'P4' });
});

app.post('/internal/betting/scan', internalAuth, async (req, res) => {
  try {
    const result = await scan(req.body || {});
    if (result.skipped) {
      return res.json({
        ok: true,
        skipped: true,
        message: result.message,
        matched: result.matched ?? 0,
        placed: result.placed ?? 0,
        metrics: result.metrics || null,
      });
    }
    const m = result.metrics || {};
    res.json({
      ok: true,
      message: result.message,
      scanned: m.scanned ?? 0,
      placed: m.placed ?? 0,
      skipped: m.skipped ?? 0,
      errors: m.errors ?? [],
      metrics: m,
    });
  } catch (e) {
    console.error('[betting] scan', e.message);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/internal/betting/orders/open', internalAuth, async (_req, res) => {
  try {
    const orders = await getOpenOrders();
    res.json({ ok: true, orders, count: orders.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[betting] listening on :${PORT} (P4)`);
});
