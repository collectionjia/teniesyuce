/**
 * 后台刷新 Redis Polymarket 赔率：网球 inplay + Dota2 + NFL。
 * 间隔：引擎配置 collect.background.odds_interval_sec（默认 1s）；POLY_ODDS_LOOP_MS 可覆盖。
 */
const tennisPolymarket = require('./tennisPolymarket');
const dota2PmCollect = require('./dota2PmCollect');

let busy = false;
let intervalHandle = null;

function loopSettings() {
  try {
    return require('./tennisEngines').getCollectBackgroundSettings();
  } catch {
    const n = Number(process.env.POLY_ODDS_LOOP_MS);
    return {
      odds_enabled: !['0', 'false', 'no', 'off'].includes(String(process.env.POLY_ODDS_LOOP || '1').toLowerCase()),
      odds_interval_ms: Number.isFinite(n) && n >= 200 ? n : 1000,
    };
  }
}

function loopEnabled() {
  return loopSettings().odds_enabled !== false;
}

function loopIntervalMs() {
  const ms = loopSettings().odds_interval_ms;
  return Number.isFinite(ms) && ms >= 200 ? ms : 1000;
}

/**
 * 一轮：网球 inplay + Dota2 + NFL
 * @param {{ clobOnly?: boolean }} [opts]
 */
async function refreshAllOnce(opts = {}) {
  const clobOnly = opts.clobOnly !== false;
  process.env.COLLECT_INPLAY_USE_PROXY = process.env.COLLECT_INPLAY_USE_PROXY || '0';

  const [tennis, dota, nfl] = await Promise.all([
    (async () => {
      if (require('./tennisBackgroundPause').isTennisBackgroundRefreshPaused()) {
        return { ok: true, skipped: true, updated: 0, failed: 0, scanned: 0, reason: 'full-collect pause' };
      }
      return tennisPolymarket.refreshInplayOddsOnce({ clobOnly }).catch((e) => ({
      ok: false,
      updated: 0,
      failed: 0,
      scanned: 0,
      error: e.message || String(e),
    }));
    })(),
    dota2PmCollect.refreshBundleOdds('dota2', { clobOnly }).catch((e) => ({
      ok: false,
      sport: 'dota2',
      updated: 0,
      failed: 0,
      scanned: 0,
      error: e.message || String(e),
    })),
    dota2PmCollect.refreshBundleOdds('nfl', { clobOnly }).catch((e) => ({
      ok: false,
      sport: 'nfl',
      updated: 0,
      failed: 0,
      scanned: 0,
      error: e.message || String(e),
    })),
  ]);

  return { tennis, dota, nfl };
}

function fmtPart(label, r) {
  if (!r) return `${label}=?`;
  if (r.skipped) return `${label}=skip`;
  if (r.error && !r.scanned) return `${label}=err`;
  return `${label}=${r.updated || 0}/${r.failed || 0}`;
}

async function tickOnce() {
  if (busy) return;
  busy = true;
  const t0 = Date.now();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await refreshAllOnce({ clobOnly: true });
    const ms = Date.now() - t0;
    console.log(
      `[poly-odds] ${fmtPart('tennis', r.tennis)} ${fmtPart('dota', r.dota)} ${fmtPart('nfl', r.nfl)} ${ms}ms`,
    );
  } catch (e) {
    console.error('[poly-odds] tick failed', e.message || e);
  } finally {
    console.warn = warn;
    busy = false;
  }
}

function stopOddsLoop() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

function startOddsLoop() {
  if (intervalHandle) return;
  if (!loopEnabled()) {
    console.log('[poly-odds] loop disabled');
    return;
  }
  const intervalMs = loopIntervalMs();
  process.env.COLLECT_INPLAY_USE_PROXY = process.env.COLLECT_INPLAY_USE_PROXY || '0';
  console.log(`[poly-odds] start interval=${intervalMs}ms`);
  intervalHandle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  setTimeout(() => {
    void tickOnce();
  }, 5_000);
}

function restartOddsLoop() {
  stopOddsLoop();
  startOddsLoop();
}

module.exports = {
  refreshAllOnce,
  startOddsLoop,
  stopOddsLoop,
  restartOddsLoop,
  tickOnce,
};
