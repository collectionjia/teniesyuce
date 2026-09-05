const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const pricing = require('../services/pricing');
const redeemCodeService = require('../services/redeemCode');

const router = express.Router();
const DAY_MS = 86400000;

function planDays(plan) {
  return { month: 30, week: 7, day: 1 }[plan] || 30;
}

router.get('/mine', auth(), async (req, res) => {
  try {
    const userId = req.user.role === 'admin' && req.query.userId
      ? Number(req.query.userId)
      : req.user.id;

    const [rows] = await pool.query(
      `SELECT s.product_id, s.expiry_at FROM subscriptions s WHERE s.user_id=?`,
      [userId]
    );
    const subs = {};
    for (const r of rows) {
      subs[r.product_id] = new Date(r.expiry_at).getTime();
    }
    res.json({ subscriptions: subs });
  } catch (e) {
    res.status(500).json({ error: '获取订阅失败' });
  }
});

router.post('/subscribe', auth(['user', 'agent', 'admin']), async (req, res) => {
  const { productId, plan } = req.body;
  if (!productId || !['month', 'week', 'day'].includes(plan)) {
    return res.status(400).json({ error: '参数错误' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[product]] = await conn.query('SELECT * FROM products WHERE id=? AND online=1', [productId]);
    if (!product) {
      await conn.rollback();
      return res.status(404).json({ error: '产品不存在或已下架' });
    }

    const [[userRow]] = await conn.query('SELECT * FROM users WHERE id=? FOR UPDATE', [req.user.id]);
    const price = pricing.priceForUser(product, plan, userRow);
    if (Number(userRow.balance) < price) {
      await conn.rollback();
      return res.status(400).json({ error: '余额不足，请先充值' });
    }

    const days = planDays(plan);
    const now = new Date();
    const [[existing]] = await conn.query(
      'SELECT expiry_at FROM subscriptions WHERE user_id=? AND product_id=?',
      [req.user.id, productId]
    );

    let base = now;
    if (existing && new Date(existing.expiry_at) > now) {
      base = new Date(existing.expiry_at);
    }
    const expiry = new Date(base.getTime() + days * DAY_MS);

    if (existing) {
      await conn.query(
        'UPDATE subscriptions SET expiry_at=? WHERE user_id=? AND product_id=?',
        [expiry, req.user.id, productId]
      );
    } else {
      await conn.query(
        'INSERT INTO subscriptions (user_id, product_id, expiry_at) VALUES (?,?,?)',
        [req.user.id, productId, expiry]
      );
    }

    await conn.query('UPDATE users SET balance = balance - ? WHERE id=?', [price, req.user.id]);

    let agentId = userRow.agent_id;
    let commission = 0;
    if (agentId) {
      const [[agent]] = await conn.query('SELECT * FROM users WHERE id=? AND role=?', [agentId, 'agent']);
      if (agent) {
        commission = Math.round(price * Number(agent.commission_rate) / 100 * 100) / 100;
        await conn.query(
          'UPDATE users SET withdrawable=withdrawable+?, month_commission=month_commission+? WHERE id=?',
          [commission, commission, agentId]
        );
      }
    }

    await conn.query(
      'INSERT INTO orders (user_id, product_id, plan, amount, agent_id, commission) VALUES (?,?,?,?,?,?)',
      [req.user.id, productId, plan, price, agentId, commission]
    );

    await conn.commit();

    const wasExpired = !existing || new Date(existing.expiry_at) <= now;
    let msg = wasExpired ? '订阅成功，已开放网页' : '续费成功';
    if (commission > 0) msg += `（已给代理佣金 ¥${commission}）`;

    const [[updatedUser]] = await conn.query('SELECT balance FROM users WHERE id=?', [req.user.id]);
    const [subRows] = await conn.query(
      'SELECT product_id, expiry_at FROM subscriptions WHERE user_id=?',
      [req.user.id]
    );
    const subs = {};
    for (const r of subRows) subs[r.product_id] = new Date(r.expiry_at).getTime();

    res.json({
      message: msg,
      balance: Number(updatedUser.balance),
      subscriptions: subs,
      expiry: expiry.getTime(),
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: '订阅失败' });
  } finally {
    conn.release();
  }
});

router.post('/redeem', auth(['user', 'agent', 'admin']), async (req, res) => {
  try {
    const result = await redeemCodeService.redeemCode(req.user.id, req.body?.code, {
      productId: req.body?.productId,
    });
    const [subRows] = await pool.query(
      'SELECT product_id, expiry_at FROM subscriptions WHERE user_id=?',
      [req.user.id],
    );
    const subs = {};
    for (const r of subRows) subs[r.product_id] = new Date(r.expiry_at).getTime();
    res.json({ ...result, subscriptions: subs });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || '兑换失败' });
  }
});

module.exports = router;
