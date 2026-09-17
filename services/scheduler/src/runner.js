const store = require('./store');
const { engineGate } = require('./engineGate');
const { executeJobTypeHttp } = require('./httpExecutor');
const { executeJobTypeLegacy } = require('./legacyExecutor');

const scheduleLocks = new Map();

function useLegacyExecutor() {
  return String(process.env.EXECUTOR_MODE || 'http').toLowerCase() === 'legacy';
}

async function executeJobType(job, params = {}) {
  if (useLegacyExecutor()) {
    return executeJobTypeLegacy(job, params);
  }
  return executeJobTypeHttp(job, params);
}

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
      return {
        accepted: true,
        runId,
        status: 'success',
        message: result?.message,
        metrics: result?.metrics,
      };
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
        try {
          await store.finishRun(runId, { status: 'timeout', error: `timeout ${job.timeoutSec}s` });
        } catch { /* ignore */ }
        resolve({ accepted: true, runId, status: 'timeout' });
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return raced;
}

module.exports = { runJob, executeJobType };
