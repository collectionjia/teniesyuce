/**
 * 网球列表：只读 Redis（tennisFullCollect 写入 tennis:bundle:full）。
 * 默认不拉 9004 monitor；需旧链路时设 TENNIS_SYNC_FROM_MONITOR=1。
 */
const tennisCache = require('./tennisCache');
const { normalizeBundle } = require('./tennisFromMonitor');

const NORM_CACHE_MS = Number(process.env.TENNIS_MEM_CACHE_MS || 15000);
let normBundle = null;
let normAt = 0;

function monitorSyncEnabled() {
  return String(process.env.TENNIS_SYNC_FROM_MONITOR || '0').trim() === '1';
}

async function getTodayBundle() {
  const now = Date.now();
  if (normBundle && now - normAt < NORM_CACHE_MS) return normBundle;

  const raw = await tennisCache.getBundle();
  if (!raw) return normBundle;
  const normalized = normalizeBundle(raw);
  const bundle = normalized || raw;
  normBundle = {
    ...bundle,
    readFrom: 'redis',
    upstream: bundle.upstream || bundle.source || 'redis',
  };
  normAt = now;
  return normBundle;
}

async function warmOnStartup() {
  const bundle = await getTodayBundle();
  if (bundle) {
    console.log(
      `[tennis/redis] ready date=${bundle.date} events=${bundle.events} ` +
        `source=${bundle.source || bundle.upstream}`,
    );
    return bundle;
  }
  console.warn(
    '[tennis/redis] empty — 请先运行 scripts/tennis-monitor/collect.py 写入 Redis',
  );
  return null;
}

module.exports = {
  getTodayBundle,
  warmOnStartup,
  monitorSyncEnabled,
  /** 采集写入后可调用，避免 15s 内存缓存仍是旧包（无 best） */
  invalidateMemCache() {
    normBundle = null;
    normAt = 0;
  },
};
