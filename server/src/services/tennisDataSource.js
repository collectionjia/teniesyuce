const redis = require('./redis');

const KEY = 'tennis:data_source';
const DEFAULT = String(process.env.TENNIS_DATA_SOURCE || 'ipwo').trim().toLowerCase();

function normalize(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'api' || v === 'allsports' || v === 'allsportsapi2') return 'api';
  if (v === 'docks500' || v === 'docks' || v === '500' || v === 'replay500') return 'docks500';
  return 'ipwo';
}

/** 网球页 Redis 写入源：ipwo / api / docks500（本地 2026_500 按日回放） */
async function get() {
  const client = await redis.getClient();
  if (!client) return normalize(DEFAULT);
  try {
    const raw = await client.get(KEY);
    return normalize(raw || DEFAULT);
  } catch (err) {
    console.error('[tennis/data-source] read failed:', err.message);
    return normalize(DEFAULT);
  }
}

async function set(source) {
  const value = normalize(source);
  const client = await redis.getClient();
  if (client) {
    try {
      await client.set(KEY, value);
    } catch (err) {
      console.error('[tennis/data-source] write failed:', err.message);
      throw err;
    }
  }
  return value;
}

function label(source) {
  const v = normalize(source);
  if (v === 'api') return 'AllSports API';
  if (v === 'docks500') return '虚拟(txt)';
  return 'IPWO';
}

module.exports = {
  get,
  set,
  normalize,
  label,
  KEY,
};
