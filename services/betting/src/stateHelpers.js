/** 与 tennisBettingEngine 去重状态兼容 */

function strategyEventKey(strategyKey, eventId) {
  const sk = String(strategyKey || '').trim() || '_';
  return `${sk}::${String(eventId)}`;
}

function ensureUidState(state, uid) {
  const u = String(uid);
  if (!state.placed[u] || Array.isArray(state.placed[u])) {
    const old = Array.isArray(state.placed[u]) ? state.placed[u].map(String) : [];
    state.placed[u] = { 'tennis-prematch': [], 'tennis-inplay': old };
  }
  if (!state.sold[u] || Array.isArray(state.sold[u])) {
    const old = Array.isArray(state.sold[u]) ? state.sold[u].map(String) : [];
    state.sold[u] = { 'tennis-prematch': [], 'tennis-inplay': old };
  }
  if (!state.stakes[u]) state.stakes[u] = { 'tennis-prematch': {}, 'tennis-inplay': {} };
  for (const p of ['tennis-prematch', 'tennis-inplay']) {
    if (!state.placed[u][p]) state.placed[u][p] = [];
    if (!state.sold[u][p]) state.sold[u][p] = [];
    if (!state.stakes[u][p]) state.stakes[u][p] = {};
  }
}

function isOpen(state, uid, product, eventId, strategyKey) {
  ensureUidState(state, uid);
  const u = String(uid);
  const placed = new Set((state.placed[u][product] || []).map(String));
  const sold = new Set((state.sold[u][product] || []).map(String));
  const id = String(eventId);
  const sk = strategyEventKey(strategyKey, id);
  if (sold.has(sk) || sold.has(id)) return false;
  return placed.has(sk) || placed.has(id);
}

function markPlaced(state, uid, product, eventId, strategyKey, shares) {
  ensureUidState(state, uid);
  const u = String(uid);
  const sk = strategyEventKey(strategyKey, eventId);
  const arr = state.placed[u][product];
  if (!arr.includes(sk)) arr.push(sk);
  if (shares > 0) {
    state.stakes[u][product][sk] = Math.round(shares * 10000) / 10000;
  }
}

function listOpenOrders(state, uid) {
  ensureUidState(state, uid);
  const u = String(uid);
  const orders = [];
  for (const product of ['tennis-prematch', 'tennis-inplay']) {
    const bucket = product === 'tennis-prematch' ? 'prematch' : 'inplay';
    const placed = state.placed[u][product] || [];
    const sold = new Set((state.sold[u][product] || []).map(String));
    for (const key of placed) {
      const s = String(key);
      if (sold.has(s)) continue;
      let eventId = s;
      let groupId = null;
      const sep = s.lastIndexOf('::');
      if (sep > 0) {
        groupId = s.slice(0, sep);
        eventId = s.slice(sep + 2);
      }
      if (sold.has(eventId)) continue;
      orders.push({
        eventId,
        product,
        bucket,
        groupId: groupId === '_' ? null : groupId,
        status: 'open',
      });
    }
  }
  return orders;
}

module.exports = {
  ensureUidState,
  isOpen,
  markPlaced,
  listOpenOrders,
  strategyEventKey,
};
