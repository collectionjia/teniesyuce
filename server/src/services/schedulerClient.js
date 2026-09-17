/**
 * 调度服务 HTTP 客户端（P6：server 不再内嵌 scheduler loop，改调 services/scheduler）
 * SCHEDULER_URL 未设时，status/run 回退本地模块（仅便于无 scheduler 进程的临时调试）
 */
function baseUrl() {
  return (process.env.SCHEDULER_URL || '').trim().replace(/\/$/, '') || null;
}

function authHeaders() {
  const token = (process.env.INTERNAL_SERVICE_TOKEN || '').trim();
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function schedulerFetch(path, opts = {}) {
  const base = baseUrl();
  if (!base) {
    const err = new Error('SCHEDULER_URL not configured');
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'scheduler request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

async function status() {
  if (!baseUrl()) {
    const schedulerLoop = require('./schedulerLoop');
    return schedulerLoop.status();
  }
  const data = await schedulerFetch('/internal/scheduler/status');
  const { ok: _ok, ...rest } = data;
  return rest;
}

async function runJob(jobId, trigger = 'manual') {
  if (!baseUrl()) {
    const { runJob: localRun } = require('./schedulerRunner');
    return localRun(jobId, trigger);
  }
  const data = await schedulerFetch(
    `/internal/scheduler/run/${encodeURIComponent(jobId)}`,
    { method: 'POST', body: '{}' },
  );
  const { ok: _ok, ...rest } = data;
  return rest;
}

async function alignTickFromConfig() {
  if (!baseUrl()) {
    const store = require('./schedulerStore');
    const tennisEngines = require('./tennisEngines');
    const cfg = await tennisEngines.getConfig();
    const sec = Number(cfg?.collect?.inplay_tick_interval_sec || 5);
    await store.syncTickIntervalFromEngines(sec);
    return;
  }
  await schedulerFetch('/internal/scheduler/align-tick', { method: 'POST', body: '{}' });
}

module.exports = { baseUrl, isRemote: () => !!baseUrl(), status, runJob, alignTickFromConfig };
