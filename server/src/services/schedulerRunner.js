/**
 * 调度任务执行：定时可互斥跳过；立即执行（manual）可并行
 */
const tennisEngines = require('./tennisEngines');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisInplayTick = require('./tennisInplayTick');
const tennisBettingEngine = require('./tennisBettingEngine');
const store = require('./schedulerStore');

/** jobId -> 本地定时互斥（单进程）；manual 不占用 */
const scheduleLocks = new Map();

async function engineGate(requireEngineOn) {
  if (!requireEngineOn) return { ok: true };
  const cfg = await tennisEngines.getConfig();
  if (requireEngineOn === 'collect') {
    if (cfg.collect?.enabled === false) {
      return { ok: false, reason: 'collect engine off' };
    }
    return { ok: true };
  }
  if (requireEngineOn === 'betting') {
    if (cfg.betting?.enabled === false) {
      return { ok: false, reason: 'betting engine off' };
    }
    return { ok: true };
  }
  if (requireEngineOn === 'condition') {
    if (cfg.condition?.enabled === false) {
      return { ok: false, reason: 'condition engine off' };
    }
    return { ok: true };
  }
  return { ok: true };
}

async function executeJobType(job, params = {}) {
  switch (job.jobType) {
    case 'collect.full': {
      const split = await tennisThreeBuckets.splitFullToThreeBuckets();
      const migP = await tennisThreeBuckets.migratePrematchByStartTime();
      const migI = await tennisThreeBuckets.migrateInplayEnded();
      return {
        message: 'collect.full done',
        metrics: { split, migratePrematch: migP, migrateInplay: migI },
      };
    }
    case 'collect.inplay_tick': {
      const cfg = await tennisEngines.getConfig();
      if (cfg.collect?.inplay_tick_enabled === false) {
        return { skipped: true, message: 'inplay_tick disabled in collect config' };
      }
      const r = await tennisInplayTick.runInplayTick();
      return { message: 'inplay tick done', metrics: r || {} };
    }
    case 'condition.query': {
      const tennisConditionApply = require('./tennisConditionApply');
      const tennisPrematchCache = require('./tennisPrematchCache');
      const tennisInplayCache = require('./tennisInplayCache');
      const tennisSettledCache = require('./tennisSettledCache');
      const caches = {
        prematch: tennisPrematchCache,
        inplay: tennisInplayCache,
        settled: tennisSettledCache,
      };
      const cfg = await tennisEngines.getConfig();
      const onlyBucket = params.bucket;
      const groupIndex = params.groupIndex != null ? Number(params.groupIndex) : null;
      const keys = onlyBucket && caches[onlyBucket] ? [onlyBucket] : Object.keys(caches);
      const metrics = {};

      function countBundle(key, bundle) {
        if (!bundle) return 0;
        if (key === 'prematch') return Number(bundle.scheduled?.eventCount || bundle.events || 0);
        return Number(bundle.live?.eventCount || bundle.events || (bundle.live?.matches || []).length || 0);
      }

      for (const key of keys) {
        let bundle = await caches[key].getBundle();
        const before = countBundle(key, bundle);
        if (bundle && cfg.condition?.enabled) {
          const full = cfg.condition?.buckets?.[key];
          let groups = full?.groups || [];
          if (groupIndex != null && groups[groupIndex]) {
            groups = [groups[groupIndex]];
          }
          const useBucket = { enabled: true, groups };
          if (groups.length) {
            if (key === 'prematch') {
              bundle = tennisConditionApply.applyToPrematchBundle(bundle, useBucket);
            } else {
              bundle = tennisConditionApply.applyToInplayBundle(bundle, useBucket);
            }
          }
        }
        metrics[key] = {
          before,
          after: countBundle(key, bundle),
          groupName: params.groupName || null,
          groupIndex,
        };
      }
      return { message: 'condition.query done', metrics };
    }
    case 'bet.scan': {
      const cfg = await tennisEngines.getConfig();
      const amountUsd = Number(params.amountUsd ?? cfg.betting?.amountUsd ?? 1);
      const userId = params.userId ?? cfg.betting?.userId;
      const r = await tennisBettingEngine.runBettingPass({
        amountUsd,
        userId,
        onlyBucket: params.bucket || null,
        onlyGroupIndex: params.groupIndex != null ? Number(params.groupIndex) : null,
      });
      return { message: 'bet.scan done', metrics: r || {} };
    }
    case 'bet.stop_loss': {
      // 现网止损已并入 runBettingPass；单独 job 时同样调用
      const cfg = await tennisEngines.getConfig();
      const r = await tennisBettingEngine.runBettingPass({
        amountUsd: Number(cfg.betting?.amountUsd ?? 1),
        userId: cfg.betting?.userId,
        onlyBucket: params.bucket || null,
        onlyGroupIndex: params.groupIndex != null ? Number(params.groupIndex) : null,
      });
      return { message: 'bet.stop_loss done', metrics: r || {} };
    }
    default: {
      const err = new Error(`unsupported jobType: ${job.jobType}`);
      err.status = 400;
      throw err;
    }
  }
}

/**
 * @param {string} jobId
 * @param {'schedule'|'manual'} trigger
 */
async function runJob(jobId, trigger = 'manual') {
  const job = await store.getJob(jobId);
  if (!job) {
    const err = new Error('job not found');
    err.status = 404;
    throw err;
  }

  if (trigger === 'schedule' && !job.enabled) {
    return { accepted: false, status: 'skipped', message: 'job disabled' };
  }

  const gate = await engineGate(job.requireEngineOn);
  if (!gate.ok) {
    if (trigger === 'schedule') {
      return { accepted: false, status: 'skipped', message: gate.reason };
    }
    const runId = await store.startRun({ jobId, trigger });
    await store.finishRun(runId, { status: 'skipped', message: gate.reason });
    return { accepted: true, runId, status: 'skipped', message: gate.reason };
  }

  if (trigger === 'schedule') {
    const lockKey = job.mutexKey || job.id;
    if (job.skipIfRunning) {
      if (scheduleLocks.get(lockKey) || (await store.hasRunningSchedule(job.id))) {
        return { accepted: false, status: 'skipped', message: 'previous schedule still running' };
      }
    }
    scheduleLocks.set(lockKey, true);
  }

  const runId = await store.startRun({ jobId, trigger });
  const timeoutMs = Math.max(5, Number(job.timeoutSec || 300)) * 1000;
  let timedOut = false;

  const work = (async () => {
    try {
      const result = await executeJobType(job, job.params || {});
      if (timedOut) return { accepted: true, runId, status: 'timeout' };
      if (result?.skipped) {
        await store.finishRun(runId, {
          status: 'skipped',
          message: result.message || 'skipped',
          metrics: result.metrics || null,
        });
        return { accepted: true, runId, status: 'skipped', message: result.message };
      }
      await store.finishRun(runId, {
        status: 'success',
        message: result?.message || 'ok',
        metrics: result?.metrics || null,
      });
      return { accepted: true, runId, status: 'success', message: result?.message, metrics: result?.metrics };
    } catch (e) {
      if (timedOut) return { accepted: true, runId, status: 'timeout' };
      await store.finishRun(runId, {
        status: 'failed',
        error: e.message || String(e),
      });
      return { accepted: true, runId, status: 'failed', error: e.message || String(e) };
    } finally {
      if (trigger === 'schedule') {
        scheduleLocks.delete(job.mutexKey || job.id);
      }
    }
  })();

  let timer;
  const raced = await Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(async () => {
        timedOut = true;
        await store.finishRun(runId, { status: 'timeout', error: `timeout ${job.timeoutSec}s` });
        if (trigger === 'schedule') scheduleLocks.delete(job.mutexKey || job.id);
        resolve({ accepted: true, runId, status: 'timeout' });
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return raced;
}

module.exports = { runJob, executeJobType, engineGate };
