const path = require('path');
require('dotenv').config({
  path: process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.resolve(__dirname, '..', '.env'),
});
const express = require('express');
const { internalAuth } = require('../../_lib/internalAuth');
const loop = require('./loop');
const store = require('./store');
const { runJob } = require('./runner');

const app = express();
const PORT = Number(process.env.PORT || 9105);

app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    const st = await loop.status();
    res.json({ ok: true, service: 'scheduler', ...st });
  } catch (e) {
    res.status(500).json({ ok: false, service: 'scheduler', error: e.message });
  }
});

app.get('/internal/scheduler/status', internalAuth, async (_req, res) => {
  res.json({ ok: true, ...(await loop.status()) });
});

app.get('/internal/scheduler/jobs', internalAuth, async (_req, res) => {
  const jobs = await store.listJobs();
  res.json({ ok: true, jobs });
});

app.post('/internal/scheduler/run/:jobId', internalAuth, async (req, res) => {
  try {
    const r = await runJob(req.params.jobId, 'manual');
    res.json({ ok: true, jobId: req.params.jobId, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.get('/internal/scheduler/jobs/:jobId/runs', internalAuth, async (req, res) => {
  const runs = await store.listRuns(req.params.jobId, {
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ ok: true, runs });
});

app.listen(PORT, async () => {
  console.log(`[scheduler] listening on :${PORT}`);
  try {
    await loop.start();
  } catch (e) {
    console.error('[scheduler] loop start failed:', e.message);
  }
});
