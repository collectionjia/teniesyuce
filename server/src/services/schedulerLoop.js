/**
 * 内嵌调度循环：interval + daily(HH:mm Asia/Shanghai)
 */
const store = require('./schedulerStore');
const { runJob } = require('./schedulerRunner');

let started = false;
let tickTimer = null;
/** jobId -> last fire marker (ms for interval, YYYY-MM-DD for daily) */
const lastFiredAt = new Map();

function shanghaiNowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === '24' ? 0 : parts.hour),
    minute: Number(parts.minute),
  };
}

async function pollOnce() {
  let jobs;
  try {
    jobs = await store.listJobs();
  } catch (e) {
    console.error('[scheduler] listJobs', e.message);
    return;
  }
  const now = Date.now();
  const sh = shanghaiNowParts();
  const hm = `${String(sh.hour).padStart(2, '0')}:${String(sh.minute).padStart(2, '0')}`;

  for (const job of jobs) {
    if (!job.enabled) continue;

    if (job.scheduleMode === 'interval') {
      const sec = Number(job.intervalSec);
      if (!(sec > 0)) continue;
      const last = Number(lastFiredAt.get(job.id) || 0);
      if (now - last < sec * 1000) continue;
      lastFiredAt.set(job.id, now);
      runJob(job.id, 'schedule').catch((e) => {
        console.error(`[scheduler] ${job.id}`, e.message || e);
      });
      continue;
    }

    if (job.scheduleMode === 'daily') {
      const target = store.normalizeDailyTime(job.dailyTime || job.cronExpr);
      if (!target || target !== hm) continue;
      const dayKey = `${sh.date}|${target}`;
      if (lastFiredAt.get(job.id) === dayKey) continue;
      lastFiredAt.set(job.id, dayKey);
      runJob(job.id, 'schedule').catch((e) => {
        console.error(`[scheduler] ${job.id}`, e.message || e);
      });
    }
  }
}

async function start() {
  if (started) return;
  started = true;
  try {
    await store.ensureTables();
  } catch (e) {
    console.error('[scheduler] ensure', e.message);
  }
  tickTimer = setInterval(() => {
    pollOnce().catch(() => {});
  }, 1000);
  console.log('[scheduler] loop started (1s poll, interval+daily)');
  setTimeout(() => pollOnce().catch(() => {}), 1500);
}

function stop() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  started = false;
}

function isRunning() {
  return started;
}

async function status() {
  const jobs = await store.listJobs();
  return {
    running: started,
    jobCount: jobs.length,
    enabledCount: jobs.filter((j) => j.enabled).length,
  };
}

module.exports = { start, stop, isRunning, status, pollOnce };
