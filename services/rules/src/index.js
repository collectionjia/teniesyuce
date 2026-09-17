const path = require('path');
require('dotenv').config({
  path: process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.resolve(__dirname, '..', '.env'),
});

const express = require('express');
const { internalAuth } = require('../../_lib/internalAuth');
const { evaluate } = require('./evaluate');
const { readMatched } = require('./matchedStore');

const app = express();
const PORT = Number(process.env.PORT || 9102);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'rules', phase: 'P3' });
});

app.post('/internal/rules/evaluate', internalAuth, async (req, res) => {
  try {
    const result = await evaluate(req.body || {});
    if (result.skipped) {
      return res.json({ ok: true, skipped: true, message: result.message, metrics: result.metrics || null });
    }
    res.json({ ok: true, message: result.message, metrics: result.metrics || null });
  } catch (e) {
    console.error('[rules] evaluate', e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/internal/rules/matched', internalAuth, async (req, res) => {
  try {
    const bucket = String(req.query.bucket || 'prematch').toLowerCase();
    const sport = String(req.query.sport || 'tennis').toLowerCase();
    const data = await readMatched(sport, bucket);
    res.json({
      ok: true,
      bucket,
      sport,
      evaluatedAt: data?.evaluatedAt || null,
      matches: data?.matches || [],
      count: (data?.matches || []).length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[rules] listening on :${PORT} (P3)`);
});
