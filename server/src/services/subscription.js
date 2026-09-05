const pool = require('../db');

const DAY_MS = 86400000;

function planDays(plan) {
  return { month: 30, week: 7, day: 1 }[plan] || 30;
}

function priceKey(plan) {
  return { month: 'price_month', week: 'price_week', day: 'price_day' }[plan];
}

async function fulfillSubscription(conn, userId, productId, plan, paidAmount) {
  const [[product]] = await conn.query('SELECT * FROM products WHERE id=?', [productId]);
  if (!product) throw new Error('产品不存在');

  const [[userRow]] = await conn.query('SELECT * FROM users WHERE id=? FOR UPDATE', [userId]);
  const days = planDays(plan);
  const now = new Date();
  const [[existing]] = await conn.query(
    'SELECT expiry_at FROM subscriptions WHERE user_id=? AND product_id=?',
    [userId, productId]
  );

  let base = now;
  if (existing && new Date(existing.expiry_at) > now) {
    base = new Date(existing.expiry_at);
  }
  const expiry = new Date(base.getTime() + days * DAY_MS);

  if (existing) {
    await conn.query(
      'UPDATE subscriptions SET expiry_at=? WHERE user_id=? AND product_id=?',
      [expiry, userId, productId]
    );
  } else {
    await conn.query(
      'INSERT INTO subscriptions (user_id, product_id, expiry_at) VALUES (?,?,?)',
      [userId, productId, expiry]
    );
  }

  let agentId = userRow.agent_id;
  let commission = 0;
  if (agentId) {
    const [[agent]] = await conn.query('SELECT * FROM users WHERE id=? AND role=?', [agentId, 'agent']);
    if (agent) {
      commission = Math.round(paidAmount * Number(agent.commission_rate) / 100 * 100) / 100;
      await conn.query(
        'UPDATE users SET withdrawable=withdrawable+?, month_commission=month_commission+? WHERE id=?',
        [commission, commission, agentId]
      );
    }
  }

  await conn.query(
    'INSERT INTO orders (user_id, product_id, plan, amount, agent_id, commission) VALUES (?,?,?,?,?,?)',
    [userId, productId, plan, paidAmount, agentId, commission]
  );

  const wasExpired = !existing || new Date(existing.expiry_at) <= now;
  let msg = wasExpired ? '订阅成功，已开放网页' : '续费成功';
  if (commission > 0) msg += `（已给代理佣金 ¥${commission}）`;

  return { expiry, message: msg, commission, wasExpired };
}

async function setSubscriptionExpiry(conn, userId, productId, expiryAt) {
  const expiry = expiryAt instanceof Date ? expiryAt : new Date(expiryAt);
  if (Number.isNaN(expiry.getTime())) throw new Error('无效的到期时间');

  const [[product]] = await conn.query('SELECT id, name FROM products WHERE id=?', [productId]);
  if (!product) throw new Error('产品不存在');

  const [[userRow]] = await conn.query(
    "SELECT id FROM users WHERE id=? AND role IN ('user','agent')",
    [userId]
  );
  if (!userRow) throw new Error('用户不存在');

  const [[existing]] = await conn.query(
    'SELECT expiry_at FROM subscriptions WHERE user_id=? AND product_id=?',
    [userId, productId]
  );

  if (existing) {
    await conn.query(
      'UPDATE subscriptions SET expiry_at=? WHERE user_id=? AND product_id=?',
      [expiry, userId, productId]
    );
  } else {
    await conn.query(
      'INSERT INTO subscriptions (user_id, product_id, expiry_at) VALUES (?,?,?)',
      [userId, productId, expiry]
    );
  }

  return { expiry, productName: product.name };
}

async function revokeSubscription(conn, userId, productId) {
  const [[product]] = await conn.query('SELECT id, name FROM products WHERE id=?', [productId]);
  if (!product) throw new Error('产品不存在');
  await conn.query('DELETE FROM subscriptions WHERE user_id=? AND product_id=?', [userId, productId]);
  return { productName: product.name };
}

module.exports = {
  fulfillSubscription,
  setSubscriptionExpiry,
  revokeSubscription,
  planDays,
  priceKey,
};
