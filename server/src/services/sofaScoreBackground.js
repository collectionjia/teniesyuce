/**
 * 后台刷新 Redis 网球 inplay Sofascore 比分（IPWO）。
 * 启动：startScoreLoop()；SOFA_SCORE_LOOP=0 关闭；SOFA_SCORE_LOOP_MS 间隔（默认 30000）。
 */
const tennisSofascore = require('./tennisSofascore');

let busy = false;
let intervalHandle = null;

function loopEnabled() {
  const v = String(process.env.SOFA_SCORE_LOOP || '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

function loopIntervalMs() {
  const n = Number(process.env.SOFA_SCORE_LOOP_MS);
  return Number.isFinite(n) && n >= 5000 ? n : 30000;
}

async function tickOnce() {
  if (busy) return;
  busy = true;
  const t0 = Date.now();
  try {
    const tennisDataSource = require('./tennisDataSource');
    if ((await tennisDataSource.get()) === 'docks500') return;

    process.env.COLLECT_PROXY_JOB = 'inplay';
    const r = await tennisSofascore.refreshInplayScoresOnce();
    if (r.skipped) return;

    const tennisInplayTick = require('./tennisInplayTick');
    const migrated = await tennisInplayTick.runBucketMigrate();

    const ms = Date.now() - t0;
    console.log(
      `[sofa-score] updated=${r.updated || 0}/${r.failed || 0} tracked=${r.tracked || 0} `
        + `mig=${migrated.migrated_prematch_to_inplay || 0}/${migrated.migrated_inplay_to_settled || 0} ${ms}ms`,
    );
  } catch (e) {
    console.error('[sofa-score] tick failed', e.message || e);
  } finally {
    busy = false;
  }
}

function startScoreLoop() {
  if (intervalHandle) return;
  if (!loopEnabled()) {
    console.log('[sofa-score] loop disabled (SOFA_SCORE_LOOP=0)');
    return;
  }
  const intervalMs = loopIntervalMs();
  console.log(`[sofa-score] start interval=${intervalMs}ms`);
  intervalHandle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  setTimeout(() => {
    void tickOnce();
  }, 8_000);
}

function stopScoreLoop() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { startScoreLoop, stopScoreLoop, tickOnce };
