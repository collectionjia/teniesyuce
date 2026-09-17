const path = require('path');
const { svc, SERVER_ROOT } = require('./lib/serverBridge');
const { getBettingConfig } = require('./lib/engineGate');
const { listOpenOrders } = require('./stateHelpers');

async function resolveUserId(cfg) {
  const uidNum = Number(
    cfg?.betting?.userId
    ?? process.env.TENNIS_BETTING_USER_ID
    ?? 0
  );
  if (uidNum) return uidNum;
  const account = cfg?.betting?.userAccount;
  if (!account) return 0;
  try {
    const pool = require(path.join(SERVER_ROOT, 'src/db'));
    const [[row]] = await pool.query(
      'SELECT id FROM users WHERE account=? LIMIT 1',
      [String(account).trim()]
    );
    return row?.id ? Number(row.id) : 0;
  } catch {
    return 0;
  }
}

async function getOpenOrders() {
  const cfg = await getBettingConfig();
  const uid = await resolveUserId(cfg);
  if (!uid) return { uid: 0, orders: [] };
  const tennisBettingEngine = svc('tennisBettingEngine');
  try {
    const state = await tennisBettingEngine.loadState();
    return { uid, orders: listOpenOrders(state, uid) };
  } catch {
    return { uid, orders: [] };
  }
}

function filterInplayOpen(orders, inplayBundle) {
  const ids = new Set((inplayBundle?.live?.matches || []).map((m) => String(m.id)));
  return orders.filter((o) => o.status === 'open' && ids.has(String(o.eventId)));
}

function bundleFreshness(inplayBundle) {
  const at = inplayBundle?.tick_at || inplayBundle?.fetched_at;
  if (!at) return { stale: true, ageSec: null };
  const ageSec = Math.round((Date.now() - new Date(at).getTime()) / 1000);
  const maxSec = Number(process.env.STOP_LOSS_MAX_DATA_AGE_SEC || 60);
  return { stale: ageSec > maxSec, ageSec, tick_at: at };
}

module.exports = { getOpenOrders, filterInplayOpen, bundleFreshness, resolveUserId };
