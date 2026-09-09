/**
 * API 对外中心：/api/engine/*
 * 鉴权 = API Key（不看角色）
 */
const express = require('express');
const crypto = require('crypto');
const { engineApiKeyAuth } = require('../middleware/engineApiKey');
const tennisEngines = require('../services/tennisEngines');
const store = require('../services/schedulerStore');
const { runJob } = require('../services/schedulerRunner');
const schedulerLoop = require('../services/schedulerLoop');
const tennisPrematchCache = require('../services/tennisPrematchCache');
const tennisInplayCache = require('../services/tennisInplayCache');
const tennisSettledCache = require('../services/tennisSettledCache');

const router = express.Router();

function meta(req) {
  return {
    requestId: req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex'),
    serverTime: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00',
    keyId: req.engineKey?.id,
  };
}

function ok(res, req, data) {
  res.json({ ok: true, data, meta: meta(req) });
}

function fail(res, req, status, error, code) {
  res.status(status).json({ ok: false, error, code, meta: meta(req) });
}

router.use(engineApiKeyAuth());

function countMatches(bundle) {
  if (!bundle) return null;
  if (Array.isArray(bundle.matches)) return bundle.matches.length;
  if (Array.isArray(bundle)) return bundle.length;
  return null;
}

async function bucketCounts() {
  const counts = { prematch: null, inplay: null, settled: null };
  try {
    counts.prematch = countMatches(await tennisPrematchCache.getBundle());
  } catch { /* ignore */ }
  try {
    counts.inplay = countMatches(await tennisInplayCache.getBundle());
  } catch { /* ignore */ }
  try {
    counts.settled = countMatches(await tennisSettledCache.getBundle());
  } catch { /* ignore */ }
  return counts;
}

async function lastRunSummary(jobId) {
  const runs = await store.listRuns(jobId, { limit: 1 });
  return runs[0] || null;
}

// —— 采集 ——
router.get('/collect/status', async (req, res) => {
  try {
    const cfg = await tennisEngines.getConfig();
    const [fullLast, tickLast] = await Promise.all([
      lastRunSummary('job_collect_full'),
      lastRunSummary('job_collect_inplay_tick'),
    ]);
    ok(res, req, {
      enabled: cfg.collect?.enabled !== false,
      inplayTickEnabled: cfg.collect?.inplay_tick_enabled !== false,
      inplayTickIntervalSec: cfg.collect?.inplay_tick_interval_sec,
      bucketCounts: await bucketCounts(),
      lastFullRun: fullLast,
      lastTickRun: tickLast,
    });
  } catch (e) {
    fail(res, req, 500, e.message, 'COLLECT_STATUS_FAILED');
  }
});

router.get('/collect/health', async (req, res) => {
  try {
    const counts = await bucketCounts();
    ok(res, req, {
      redisBuckets: counts,
      note: 'coarse health: bucket readable',
    });
  } catch (e) {
    fail(res, req, 500, e.message, 'COLLECT_HEALTH_FAILED');
  }
});

router.post('/collect/full/run', async (req, res) => {
  try {
    const r = await runJob('job_collect_full', 'manual');
    ok(res, req, { accepted: true, ...r, jobId: 'job_collect_full', status: r.status || 'queued' });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'COLLECT_FULL_RUN_FAILED');
  }
});

router.post('/collect/inplay-tick/run', async (req, res) => {
  try {
    const r = await runJob('job_collect_inplay_tick', 'manual');
    ok(res, req, { accepted: true, ...r, jobId: 'job_collect_inplay_tick' });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'COLLECT_TICK_RUN_FAILED');
  }
});

// —— 条件引擎：规则 CRUD（API Key）——
router.get('/condition/status', async (req, res) => {
  try {
    const cfg = await tennisEngines.getConfig();
    const buckets = cfg.condition?.buckets || {};
    const summary = {};
    for (const [k, v] of Object.entries(buckets)) {
      summary[k] = {
        enabled: !!v?.enabled,
        groupCount: Array.isArray(v?.groups) ? v.groups.length : 0,
      };
    }
    ok(res, req, {
      open: !!cfg.condition?.enabled,
      buckets: summary,
    });
  } catch (e) {
    fail(res, req, 500, e.message, 'CONDITION_STATUS_FAILED');
  }
});

router.get('/condition/rules', async (req, res) => {
  try {
    ok(res, req, await tennisEngines.getCondition());
  } catch (e) {
    fail(res, req, 500, e.message, 'CONDITION_RULES_FAILED');
  }
});

/** 整表更新：{ open?, buckets? } */
router.put('/condition/rules', async (req, res) => {
  try {
    const body = req.body || {};
    await tennisEngines.putConditionRules({
      open: body.open != null ? body.open : body.enabled,
      buckets: body.buckets,
    });
    ok(res, req, await tennisEngines.getCondition());
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_RULES_PUT_FAILED');
  }
});

/** 总开关 */
router.post('/condition/switch', async (req, res) => {
  try {
    const open = req.body?.open != null ? !!req.body.open : !!req.body?.enabled;
    await tennisEngines.setConditionOpen(open);
    ok(res, req, await tennisEngines.getCondition());
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_SWITCH_FAILED');
  }
});

router.get('/condition/rules/:bucket', async (req, res) => {
  try {
    const bucket = String(req.params.bucket || '');
    if (!tennisEngines.BUCKET_KEYS.includes(bucket)) {
      return fail(res, req, 400, `bucket must be one of ${tennisEngines.BUCKET_KEYS.join(',')}`, 'BAD_BUCKET');
    }
    const c = await tennisEngines.getCondition();
    ok(res, req, {
      open: c.open,
      bucket,
      ...(c.buckets[bucket] || { enabled: false, groups: [] }),
    });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_BUCKET_GET_FAILED');
  }
});

/** 替换某桶：{ enabled?, groups? } */
router.put('/condition/rules/:bucket', async (req, res) => {
  try {
    const bucket = String(req.params.bucket || '');
    await tennisEngines.putConditionBucket(bucket, req.body || {});
    const c = await tennisEngines.getCondition();
    ok(res, req, { open: c.open, bucket, ...(c.buckets[bucket] || {}) });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_BUCKET_PUT_FAILED');
  }
});

/** 只改桶开关：{ enabled } */
router.patch('/condition/rules/:bucket', async (req, res) => {
  try {
    const bucket = String(req.params.bucket || '');
    const enabled = req.body?.enabled != null ? !!req.body.enabled : !!req.body?.open;
    await tennisEngines.putConditionBucket(bucket, { enabled });
    const c = await tennisEngines.getCondition();
    ok(res, req, { open: c.open, bucket, ...(c.buckets[bucket] || {}) });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_BUCKET_PATCH_FAILED');
  }
});

/** 新增条件组 */
router.post('/condition/rules/:bucket/groups', async (req, res) => {
  try {
    const bucket = String(req.params.bucket || '');
    await tennisEngines.addConditionGroup(bucket, req.body || {});
    const c = await tennisEngines.getCondition();
    const groups = c.buckets[bucket]?.groups || [];
    ok(res, req, {
      open: c.open,
      bucket,
      index: groups.length - 1,
      group: groups[groups.length - 1],
      groups,
      enabled: !!c.buckets[bucket]?.enabled,
    });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_GROUP_ADD_FAILED');
  }
});

/** 部分更新条件组 */
router.patch('/condition/rules/:bucket/groups/:index', async (req, res) => {
  try {
    const bucket = String(req.params.bucket || '');
    const index = req.params.index;
    await tennisEngines.updateConditionGroup(bucket, index, req.body || {});
    const c = await tennisEngines.getCondition();
    const groups = c.buckets[bucket]?.groups || [];
    const i = Number(index);
    ok(res, req, {
      open: c.open,
      bucket,
      index: i,
      group: groups[i],
      groups,
      enabled: !!c.buckets[bucket]?.enabled,
    });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_GROUP_PATCH_FAILED');
  }
});

/** 整组替换 */
router.put('/condition/rules/:bucket/groups/:index', async (req, res) => {
  try {
    const bucket = String(req.params.bucket || '');
    const index = req.params.index;
    await tennisEngines.replaceConditionGroup(bucket, index, req.body || {});
    const c = await tennisEngines.getCondition();
    const groups = c.buckets[bucket]?.groups || [];
    const i = Number(index);
    ok(res, req, {
      open: c.open,
      bucket,
      index: i,
      group: groups[i],
      groups,
      enabled: !!c.buckets[bucket]?.enabled,
    });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_GROUP_PUT_FAILED');
  }
});

/** 删除条件组（至少保留 1 个空组） */
router.delete('/condition/rules/:bucket/groups/:index', async (req, res) => {
  try {
    const bucket = String(req.params.bucket || '');
    const index = req.params.index;
    await tennisEngines.deleteConditionGroup(bucket, index);
    const c = await tennisEngines.getCondition();
    ok(res, req, {
      open: c.open,
      bucket,
      groups: c.buckets[bucket]?.groups || [],
      enabled: !!c.buckets[bucket]?.enabled,
    });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'CONDITION_GROUP_DELETE_FAILED');
  }
});

// —— 投注 ——
router.get('/betting/status', async (req, res) => {
  try {
    const cfg = await tennisEngines.getConfig();
    const last = await lastRunSummary('job_bet_scan');
    const buckets = {};
    for (const [k, v] of Object.entries(cfg.betting?.buckets || {})) {
      buckets[k] = {
        enabled: !!v?.enabled,
        groupCount: Array.isArray(v?.groups) ? v.groups.length : 0,
      };
    }
    ok(res, req, {
      open: !!cfg.betting?.enabled,
      amountUsd: cfg.betting?.amountUsd,
      buckets,
      lastScanRun: last,
    });
  } catch (e) {
    fail(res, req, 500, e.message, 'BETTING_STATUS_FAILED');
  }
});

router.get('/betting/rules', async (req, res) => {
  try {
    const cfg = await tennisEngines.getConfig();
    ok(res, req, {
      open: !!cfg.betting?.enabled,
      amountUsd: cfg.betting?.amountUsd,
      buckets: cfg.betting?.buckets || {},
      rules: cfg.betting?.rules || {},
    });
  } catch (e) {
    fail(res, req, 500, e.message, 'BETTING_RULES_FAILED');
  }
});

router.post('/betting/scan/run', async (req, res) => {
  try {
    const r = await runJob('job_bet_scan', 'manual');
    ok(res, req, { accepted: true, ...r, jobId: 'job_bet_scan' });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'BETTING_SCAN_FAILED');
  }
});

router.post('/betting/stop-loss/run', async (req, res) => {
  try {
    // P0：与 scan 同实现
    const r = await runJob('job_bet_scan', 'manual');
    ok(res, req, { accepted: true, ...r, jobId: 'job_bet_scan', note: 'stop-loss folded into bet.scan' });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'BETTING_STOP_LOSS_FAILED');
  }
});

// —— 调度 ——
router.get('/scheduler/status', async (req, res) => {
  try {
    ok(res, req, await schedulerLoop.status());
  } catch (e) {
    fail(res, req, 500, e.message, 'SCHEDULER_STATUS_FAILED');
  }
});

router.get('/scheduler/jobs', async (req, res) => {
  try {
    const [jobs, nameOptions] = await Promise.all([
      store.listJobs(),
      store.listNameOptions(),
    ]);
    ok(res, req, { jobs, jobTypes: store.listJobTypeDefs(), nameOptions });
  } catch (e) {
    fail(res, req, 500, e.message, 'SCHEDULER_JOBS_FAILED');
  }
});

router.post('/scheduler/jobs', async (req, res) => {
  try {
    const body = req.body || {};
    const job = await store.createJob({
      jobType: body.jobType || body.job_type,
      name: body.name,
      enabled: body.enabled,
      scheduleMode: body.scheduleMode || body.schedule_mode,
      intervalSec: body.intervalSec ?? body.interval_sec,
      dailyTime: body.dailyTime || body.daily_time || body.cronExpr,
      timeoutSec: body.timeoutSec ?? body.timeout_sec,
      params: body.params && typeof body.params === 'object' ? body.params : null,
    });
    ok(res, req, { job });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'SCHEDULER_CREATE_FAILED');
  }
});

router.get('/scheduler/jobs/:id', async (req, res) => {
  try {
    const job = await store.getJob(req.params.id);
    if (!job) return fail(res, req, 404, 'job not found', 'JOB_NOT_FOUND');
    ok(res, req, { job });
  } catch (e) {
    fail(res, req, 500, e.message, 'SCHEDULER_JOB_FAILED');
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
    ok(res, req, { job });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'SCHEDULER_PATCH_FAILED');
  }
});

router.delete('/scheduler/jobs/:id', async (req, res) => {
  try {
    await store.deleteJob(req.params.id);
    ok(res, req, { deleted: true, id: req.params.id });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'SCHEDULER_DELETE_FAILED');
  }
});

router.post('/scheduler/jobs/:id/delete', async (req, res) => {
  try {
    await store.deleteJob(req.params.id);
    ok(res, req, { deleted: true, id: req.params.id });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'SCHEDULER_DELETE_FAILED');
  }
});

router.post('/scheduler/jobs/:id/enable', async (req, res) => {
  try {
    const job = await store.setJobEnabled(req.params.id, true);
    ok(res, req, { job });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'SCHEDULER_ENABLE_FAILED');
  }
});

router.post('/scheduler/jobs/:id/disable', async (req, res) => {
  try {
    const job = await store.setJobEnabled(req.params.id, false);
    ok(res, req, { job });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'SCHEDULER_DISABLE_FAILED');
  }
});

router.post('/scheduler/jobs/:id/run', async (req, res) => {
  try {
    const r = await runJob(req.params.id, 'manual');
    ok(res, req, { accepted: true, jobId: req.params.id, ...r });
  } catch (e) {
    fail(res, req, e.status || 500, e.message, 'SCHEDULER_RUN_FAILED');
  }
});

router.get('/scheduler/jobs/:id/runs', async (req, res) => {
  try {
    const runs = await store.listRuns(req.params.id, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    ok(res, req, { runs });
  } catch (e) {
    fail(res, req, 500, e.message, 'SCHEDULER_RUNS_FAILED');
  }
});

router.get('/scheduler/runs/:runId', async (req, res) => {
  try {
    const run = await store.getRun(req.params.runId);
    if (!run) return fail(res, req, 404, 'run not found', 'RUN_NOT_FOUND');
    ok(res, req, { run });
  } catch (e) {
    fail(res, req, 500, e.message, 'SCHEDULER_RUN_GET_FAILED');
  }
});

module.exports = router;
