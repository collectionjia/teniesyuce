/**
 * 投注/止损调度执行日志（Redis 列表，新在前）
 */
const redis = require('./redis');

const KEY = 'tennis:engines:betting:exec_log';
const MAX = 800;

function nowIso() {
  return new Date().toISOString();
}

async function append(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return;
  const client = await redis.getClient();
  if (!client) return;
  const payload = list.map((e) => JSON.stringify({
    id: e.id || `bl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: e.at || nowIso(),
    ...e,
  }));
  try {
    await client.lPush(KEY, ...payload);
    await client.lTrim(KEY, 0, MAX - 1);
  } catch (err) {
    console.warn('[betting-exec-log] append', err.message || err);
  }
}

async function list({ limit = 200, strategyKey = '', type = '', bucket = '' } = {}) {
  const client = await redis.getClient();
  if (!client) return { ok: true, items: [], total: 0, note: 'redis unavailable' };
  const n = Math.min(Math.max(Number(limit) || 200, 1), MAX);
  const sk = String(strategyKey || '').trim();
  const ty = String(type || '').trim().toLowerCase();
  const bk = String(bucket || '').trim().toLowerCase();
  const fetchN = (sk || ty || bk) ? Math.min(MAX, n * 5) : n;
  let raw;
  try {
    raw = await client.lRange(KEY, 0, fetchN - 1);
  } catch (err) {
    return { ok: false, items: [], error: err.message || 'read failed' };
  }
  const items = [];
  for (const s of raw || []) {
    let j;
    try { j = JSON.parse(s); } catch { continue; }
    if (sk && String(j.strategyKey || '') !== sk && !(Array.isArray(j.strategyKeys) && j.strategyKeys.includes(sk))) {
      continue;
    }
    if (ty && String(j.type || '').toLowerCase() !== ty) continue;
    if (bk && String(j.bucket || '').toLowerCase() !== bk) continue;
    items.push(j);
    if (items.length >= n) break;
  }
  let total = items.length;
  try {
    total = await client.lLen(KEY);
  } catch { /* ignore */ }
  return { ok: true, items, total, limit: n };
}

async function clear() {
  const client = await redis.getClient();
  if (!client) return { ok: false, error: 'redis unavailable' };
  await client.del(KEY);
  return { ok: true };
}

module.exports = {
  append,
  list,
  clear,
  MAX,
};
