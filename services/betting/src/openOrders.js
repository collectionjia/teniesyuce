const { svc } = require('./lib/serverBridge');
const { getBettingConfig } = require('./lib/engineGate');
const { listOpenOrders } = require('./stateHelpers');
const { SERVER_ROOT } = require('./lib/serverBridge');
const path = require('path');

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
  if (!uid) return [];
  const tennisBettingEngine = svc('tennisBettingEngine');
  let state;
  try {
    state = await tennisBettingEngine.loadState();
  } catch {
    return [];
  }
  return listOpenOrders(state, uid);
}

module.exports = { getOpenOrders };
