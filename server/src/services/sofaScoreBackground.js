/**
 * 后台刷新 Redis 网球 inplay Sofascore 比分（直连）。
 * 间隔：引擎配置 collect.background.score_interval_sec（默认 30s）；SOFA_SCORE_LOOP_MS 可覆盖。
 */
const tennisSofascore = require('./tennisSofascore');

let busy = false;
let intervalHandle = null;
const logLines = [];
let last = { at: null, ok: null, message: null, ms: null };

function pushLog(line) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  logLines.push(`[${t}] ${line}`);
  if (logLines.length > 120) logLines.splice(0, logLines.length - 120);
}

function loopSettings() {
  try {
    return require('./tennisEngines').getCollectBackgroundSettings();
  } catch {
    const n = Number(process.env.SOFA_SCORE_LOOP_MS);
    return {
      score_enabled: !['0', 'false', 'no', 'off'].includes(String(process.env.SOFA_SCORE_LOOP || '0').toLowerCase()),
      score_interval_ms: Number.isFinite(n) && n >= 5000 ? n : 30000,
    };
  }
}

function loopEnabled() {
  return loopSettings().score_enabled !== false;
}

function loopIntervalMs() {
  const ms = loopSettings().score_interval_ms;
  return Number.isFinite(ms) && ms >= 5000 ? ms : 30000;
}

function statusPayload() {
  const s = loopSettings();
  let ipwo = { last_tick: 0, total: 0 };
  try {
    ipwo = require('../lib/httpProxyAgent').getSofaIpwoStats();
  } catch { /* ignore */ }
  return {
    running: !!intervalHandle,
    busy,
    enabled: s.score_enabled !== false,
    interval_ms: loopIntervalMs(),
    interval_sec: s.score_interval_sec,
    ipwo_total: ipwo.total,
    ipwo_last_tick: last.ipwo_calls ?? ipwo.last_tick,
    last: { ...last },
    logs: logLines.slice(-80),
  };
}

function clearLogs() {
  logLines.length = 0;
  return { ok: true, cleared: true };
}

async function tickOnce() {
  if (busy) {
    pushLog('skip: previous tick still running');
    return;
  }
  busy = true;
  const t0 = Date.now();
  try {
    const tennisDataSource = require('./tennisDataSource');
    if ((await tennisDataSource.get()) === 'docks500') {
      last = { at: new Date().toISOString(), ok: true, message: 'skip virtual docks500', ms: 0 };
      pushLog('skip: virtual docks500');
      return;
    }
    if (require('./tennisBackgroundPause').isTennisBackgroundRefreshPaused()) {
      last = { at: new Date().toISOString(), ok: true, message: 'skip full-collect pause', ms: 0 };
      pushLog('skip: full-collect pause');
      return;
    }

    process.env.COLLECT_PROXY_JOB = 'inplay';
    const r = await tennisSofascore.refreshInplayScoresOnce();
    if (r.skipped) {
      const msg = r.reason || 'skipped';
      const ipwoNote = r.ipwo_calls != null ? ` ipwo=${r.ipwo_calls}` : '';
      last = {
        at: new Date().toISOString(),
        ok: true,
        message: `${msg}${ipwoNote}`,
        ms: Date.now() - t0,
        ipwo_calls: r.ipwo_calls ?? 0,
        ipwo_total: r.ipwo_total ?? 0,
        skipped_not_started: r.skipped_not_started ?? 0,
      };
      pushLog(`skip: ${msg}${ipwoNote}`);
      return;
    }

    const tennisInplayTick = require('./tennisInplayTick');
    const migrated = await tennisInplayTick.runBucketMigrate();

    const ms = Date.now() - t0;
    const line =
      `updated=${r.updated || 0}/${r.failed || 0} tracked=${r.tracked || 0} `
      + `skip_ns=${r.skipped_not_started || 0} ipwo=${r.ipwo_calls || 0} `
      + `mig=${migrated.migrated_prematch_to_inplay || 0}/${migrated.migrated_inplay_to_settled || 0} ${ms}ms`;
    console.log(`[sofa-score] ${line}`);
    last = {
      at: new Date().toISOString(),
      ok: (r.failed || 0) === 0 || (r.updated || 0) > 0,
      message: line,
      ms,
      updated: r.updated || 0,
      failed: r.failed || 0,
      ipwo_calls: r.ipwo_calls ?? 0,
      ipwo_total: r.ipwo_total ?? 0,
      skipped_not_started: r.skipped_not_started ?? 0,
    };
    pushLog(line);
    if (r.process_log) pushLog(String(r.process_log).split('\n').slice(-3).join(' | '));
  } catch (e) {
    const msg = e.message || String(e);
    console.error('[sofa-score] tick failed', msg);
    last = { at: new Date().toISOString(), ok: false, message: msg, ms: Date.now() - t0 };
    pushLog(`error: ${msg}`);
  } finally {
    busy = false;
  }
}

function stopScoreLoop() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  pushLog('loop stopped');
}

function startScoreLoop() {
  if (intervalHandle) return;
  if (!loopEnabled()) {
    console.log('[sofa-score] loop disabled');
    pushLog('loop disabled (score_enabled=0)');
    return;
  }
  const intervalMs = loopIntervalMs();
  console.log(`[sofa-score] start interval=${intervalMs}ms`);
  pushLog(`loop start interval=${intervalMs}ms`);
  intervalHandle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  setTimeout(() => {
    void tickOnce();
  }, 8_000);
}

function restartScoreLoop() {
  stopScoreLoop();
  startScoreLoop();
}

module.exports = {
  startScoreLoop,
  stopScoreLoop,
  restartScoreLoop,
  tickOnce,
  statusPayload,
  clearLogs,
};
