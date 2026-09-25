/**
 * 后台刷新 Redis 中已采集赛事的 Polymarket 赔率：网球盘中 + Dota2 + NFL。
 * 启动：startOddsLoop()；POLY_ODDS_LOOP=0 关闭；POLY_ODDS_LOOP_MS 间隔（默认 1000）。
 */
const tennisPolymarket = require('./tennisPolymarket');
const dota2PmCollect = require('./dota2PmCollect');

let busy = false;
let intervalHandle = null;

function loopEnabled() {
  const v = String(process.env.POLY_ODDS_LOOP || '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

function loopIntervalMs() {
  const n = Number(process.env.POLY_ODDS_LOOP_MS);
  return Number.isFinite(n) && n >= 200 ? n : 1000;
}

/**
 * 一轮：网球 inplay + Dota2 + NFL
 * @param {{ clobOnly?: boolean }} [opts]
 */
async function refreshAllOnce(opts = {}) {
  const clobOnly = opts.clobOnly !== false;
  process.env.COLLECT_INPLAY_USE_PROXY = process.env.COLLECT_INPLAY_USE_PROXY || '0';

  const [tennis, dota, nfl] = await Promise.all([
    tennisPolymarket.refreshInplayOddsOnce({ clobOnly }).catch((e) => ({
      ok: false,
      updated: 0,
      failed: 0,
      scanned: 0,
      error: e.message || String(e),
    })),
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

function startOddsLoop() {
  if (intervalHandle) return;
  if (!loopEnabled()) {
    console.log('[poly-odds] loop disabled (POLY_ODDS_LOOP=0)');
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

function stopOddsLoop() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = {
  refreshAllOnce,
  startOddsLoop,
  stopOddsLoop,
  tickOnce,
};
