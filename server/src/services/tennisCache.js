const redis = require('./redis');

const BUNDLE_KEY = 'tennis:bundle:full';
const META_KEY = 'tennis:bundle:fetched_at';
const TTL_SEC = Number(process.env.TENNIS_CACHE_TTL_SEC || 86400);

function normalizeFetchedAt(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** 直接读 Redis 全量包（前端唯一数据源） */
async function getBundle() {
  const client = await redis.getClient();
  if (!client) return null;
  try {
    const raw = await client.get(BUNDLE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[tennis/cache] read failed:', err.message);
    return null;
  }
}

/** @deprecated 保留兼容；现已不依赖 MySQL fetched_at */
async function getCachedBundle(_fetchedAt) {
  return getBundle();
}

async function setCachedBundle(bundle, fetchedAt) {
  const client = await redis.getClient();
  if (!client || !bundle) return false;

  const meta = normalizeFetchedAt(fetchedAt ?? bundle.fetched_at);
  try {
    await client
      .multi()
      .set(BUNDLE_KEY, JSON.stringify(bundle), { EX: TTL_SEC })
      .set(META_KEY, meta, { EX: TTL_SEC })
      .exec();
    return true;
  } catch (err) {
    console.error('[tennis/cache] write failed:', err.message);
    return false;
  }
}

async function invalidateCache() {
  const client = await redis.getClient();
  if (!client) return;
  try {
    await client.del([BUNDLE_KEY, META_KEY]);
  } catch (err) {
    console.error('[tennis/cache] invalidate failed:', err.message);
  }
}

async function refreshCache(loadFn) {
  await invalidateCache();
  const bundle = await loadFn();
  await setCachedBundle(bundle, bundle?.fetched_at);
  return bundle;
}

module.exports = {
  getBundle,
  getCachedBundle,
  setCachedBundle,
  invalidateCache,
  refreshCache,
};
