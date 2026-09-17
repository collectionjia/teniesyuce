/** 与 betting / tennisBettingEngine 状态结构一致 */

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
      orders.push({ eventId, product, bucket, groupId: groupId === '_' ? null : groupId, status: 'open' });
    }
  }
  return orders;
}

module.exports = { listOpenOrders };
