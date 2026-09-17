/**
 * 管理员网页：调度中心 + 引擎 API Key 管理（JWT admin，非 API Key）
 */
const express = require('express');
const { auth } = require('../middleware/auth');
const store = require('../services/schedulerStore');
const schedulerClient = require('../services/schedulerClient');
const engineApiKeys = require('../services/engineApiKeys');
const tennisEngines = require('../services/tennisEngines');

const router = express.Router();
router.use(auth(['admin']));

router.get('/scheduler/status', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await schedulerClient.status()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/scheduler/jobs', async (_req, res) => {
  try {
    const [jobs, nameOptions] = await Promise.all([
      store.listJobs(),
      store.listNameOptions(),
    ]);
    res.json({ ok: true, jobs, jobTypes: store.listJobTypeDefs(), nameOptions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/scheduler/name-options', async (_req, res) => {
  try {
    const nameOptions = await store.listNameOptions();
    res.json({ ok: true, nameOptions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/scheduler/jobs', async (req, res) => {
  try {
    const body = req.body || {};
    const params = body.params && typeof body.params === 'object' ? body.params : null;
    const job = await store.createJob({
      jobType: body.jobType || body.job_type,
      name: body.name,
      enabled: body.enabled,
      scheduleMode: body.scheduleMode || body.schedule_mode,
      intervalSec: body.intervalSec ?? body.interval_sec,
      dailyTime: body.dailyTime || body.daily_time || body.cronExpr,
      timeoutSec: body.timeoutSec ?? body.timeout_sec,
      params,
      createdBy: req.user?.id,
    });
    res.json({ ok: true, job });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.patch('/scheduler/jobs/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {
      enabled: body.enabled,
      intervalSec: body.intervalSec ?? body.interval_sec,
      scheduleMode: body.scheduleMode || body.schedule_mode,
      dailyTime: body.dailyTime || body.daily_time || body.cronExpr,
      name: body.name,
      timeoutSec: body.timeoutSec ?? body.timeout_sec,
    };
    if (body.params !== undefined) patch.params = body.params;
    const job = await store.updateJob(req.params.id, patch);
    if (req.params.id === 'job_collect_inplay_tick' && body.intervalSec != null) {
      const sec = Number(body.intervalSec);
      if ([1, 2, 5, 10].includes(sec)) {
        await tennisEngines.setConfig({
          collect: { inplay_tick_interval_sec: sec },
        });
      }
    }
    res.json({ ok: true, job });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.delete('/scheduler/jobs/:id', async (req, res) => {
  try {
    await store.deleteJob(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/scheduler/jobs/:id/delete', async (req, res) => {
  try {
    await store.deleteJob(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/scheduler/jobs/:id/enable', async (req, res) => {
  try {
    const job = await store.setJobEnabled(req.params.id, true);
    res.json({ ok: true, job });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/scheduler/jobs/:id/disable', async (req, res) => {
  try {
    const job = await store.setJobEnabled(req.params.id, false);
    res.json({ ok: true, job });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.post('/scheduler/jobs/:id/run', async (req, res) => {
  try {
    const r = await schedulerClient.runJob(req.params.id, 'manual');
    res.json({ ok: true, jobId: req.params.id, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

router.get('/scheduler/jobs/:id/runs', async (req, res) => {
  try {
    const runs = await store.listRuns(req.params.id, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ ok: true, runs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/scheduler/jobs/:id/runs/clear', async (req, res) => {
  try {
    const r = await store.clearRuns(req.params.id);
    res.json({ ok: true, jobId: req.params.id, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// —— API Key ——
router.get('/engine-api-keys', async (_req, res) => {
  try {
    const keys = await engineApiKeys.listKeys();
    res.json({ ok: true, keys });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/engine-api-keys', async (req, res) => {
  try {
    const name = (req.body?.name || 'engine-key').toString().slice(0, 128);
    const ownerUserId = req.body?.ownerUserId != null ? Number(req.body.ownerUserId) : null;
    const created = await engineApiKeys.createKey({
      name,
      ownerUserId: Number.isFinite(ownerUserId) ? ownerUserId : null,
      createdBy: req.user?.id,
    });
    res.json({
      ok: true,
      key: {
        id: created.id,
        name: created.name,
        keyPrefix: created.keyPrefix,
        ownerUserId: created.ownerUserId,
      },
      apiKey: created.apiKey,
      note: '请立即保存 apiKey，之后无法再次查看明文',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/engine-api-keys/:id/revoke', async (req, res) => {
  try {
    await engineApiKeys.revokeKey(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function handleEngineApiKeyDelete(req, res) {
  try {
    const okDel = await engineApiKeys.deleteKey(Number(req.params.id));
    if (!okDel) return res.status(404).json({ ok: false, error: '密钥不存在' });
    res.json({ ok: true, deleted: true, id: Number(req.params.id) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

router.delete('/engine-api-keys/:id', handleEngineApiKeyDelete);
router.post('/engine-api-keys/:id/delete', handleEngineApiKeyDelete);

router.post('/engine-api-keys/:id/enable', async (req, res) => {
  try {
    await engineApiKeys.setEnabled(Number(req.params.id), true);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
