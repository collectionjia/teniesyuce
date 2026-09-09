const redis = require('./redis');

const BUNDLE_KEY = 'tennis:bundle:prematch';
const META_KEY = 'tennis:bundle:prematch:fetched_at';
const TTL_SEC = Number(process.env.TENNIS_CACHE_TTL_SEC || 86400);

function normalizeFetchedAt(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

async function getBundle() {
  const client = await redis.getClient();
  if (!client) return null;
  try {
    const raw = await client.get(BUNDLE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[tennis/prematch-cache] read failed:', err.message);
    return null;
  }
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
    console.error('[tennis/prematch-cache] write failed:', err.message);
    return false;
  }
}

module.exports = {
  getBundle,
  setCachedBundle,
  BUNDLE_KEY,
  META_KEY,
};
