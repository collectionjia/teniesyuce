const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.get('/overview', auth(['agent', 'admin']), async (req, res) => {
  try {
    const agentId = req.user.role === 'admin' && req.query.agentId
      ? Number(req.query.agentId)
      : req.user.id;

    const [[agent]] = await pool.query(
      "SELECT invite_code, commission_rate, withdrawable, month_commission FROM users WHERE id=? AND role='agent'",
      [agentId]
    );
    if (!agent) return res.status(404).json({ error: '代理不存在' });

    const [[{ clientCount }]] = await pool.query(
      "SELECT COUNT(*) AS clientCount FROM users WHERE agent_id=? AND role='user'",
      [agentId]
    );

    const [trendRows] = await pool.query(
      `SELECT DATE(created_at) AS d, SUM(commission) AS v FROM orders
       WHERE agent_id=? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(created_at) ORDER BY d`,
      [agentId]
    );

    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = trendRows.find(r => {
        const rd = new Date(r.d).toISOString().slice(0, 10);
        return rd === key;
      });
      trend.push(found ? Number(found.v) : 0);
    }

    res.json({
      monthCommission: Number(agent.month_commission),
      withdrawable: Number(agent.withdrawable),
      rate: Number(agent.commission_rate),
      inviteCode: agent.invite_code,
      clientCount,
      trend,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取代理概览失败' });
  }
});

router.get('/orders', auth(['agent', 'admin']), async (req, res) => {
  try {
    const agentId = req.user.role === 'admin' && req.query.agentId
      ? Number(req.query.agentId)
      : req.user.id;

    const { status } = req.query;
    let statusClause = '';
    if (status === 'paid') statusClause = "AND po.status='paid'";
    else if (status === 'pending') statusClause = "AND po.status='pending'";

    const [rows] = await pool.query(
      `SELECT po.id, po.reference, po.user_id, po.product_id, po.plan, po.amount, po.status,
              po.created_at, po.paid_at,
              u.name AS user_name, u.account AS user_account,
              p.name AS product_name
       FROM payment_orders po
       JOIN users u ON po.user_id = u.id
       JOIN products p ON po.product_id = p.id
       WHERE u.agent_id=? ${statusClause}
       ORDER BY po.created_at DESC
       LIMIT 200`,
      [agentId]
    );

    res.json({
      orders: rows.map((o) => ({
        id: o.id,
        reference: o.reference,
        userId: o.user_id,
        productId: o.product_id,
        user: o.user_name,
        account: o.user_account,
        product: o.product_name,
        plan: o.plan,
        amount: Number(o.amount),
        status: o.status,
        createdAt: o.created_at,
        paidAt: o.paid_at,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取客户订单失败' });
  }
});

router.get('/clients', auth(['agent', 'admin']), async (req, res) => {
  try {
    const agentId = req.user.role === 'admin' && req.query.agentId
      ? Number(req.query.agentId)
      : req.user.id;

    const [rows] = await pool.query(
      `SELECT o.id, u.name, p.name AS product, o.plan, o.amount, o.created_at
       FROM orders o
       JOIN users u ON o.user_id = u.id
       JOIN products p ON o.product_id = p.id
       WHERE o.agent_id=?
       ORDER BY o.created_at DESC LIMIT 50`,
      [agentId]
    );

    const [boundUsers] = await pool.query(
      `SELECT u.id, u.name FROM users u
       WHERE u.agent_id=? AND u.role='user'
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.agent_id=?)`,
      [agentId, agentId]
    );

    const clients = [
      ...boundUsers.map(u => ({ id: 'u' + u.id, name: u.name, product: '待订阅', plan: '—', amount: 0 })),
      ...rows.map(r => ({
        id: r.id,
        name: r.name,
        product: r.product,
        plan: r.plan,
        amount: Number(r.amount),
      })),
    ];

    res.json({ clients });
  } catch (e) {
    res.status(500).json({ error: '获取客户列表失败' });
  }
});

router.post('/withdraw', auth(['agent']), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[agent]] = await conn.query('SELECT withdrawable FROM users WHERE id=? FOR UPDATE', [req.user.id]);
    const amount = Number(agent.withdrawable);
    if (amount <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: '暂无可提现佣金' });
    }

    await conn.query(
      "INSERT INTO withdrawals (agent_id, amount, status) VALUES (?,?,'pending')",
      [req.user.id, amount]
    );
    await conn.query('UPDATE users SET withdrawable=0 WHERE id=?', [req.user.id]);
    await conn.commit();

    const [logs] = await pool.query(
      'SELECT id, amount, status, created_at FROM withdrawals WHERE agent_id=? ORDER BY created_at DESC LIMIT 10',
      [req.user.id]
    );

    res.json({
      message: '提现申请已提交',
      withdrawable: 0,
      withdrawLog: logs.map(w => ({
        id: w.id,
        date: formatDate(w.created_at),
        amount: Number(w.amount),
        status: statusText(w.status),
      })),
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: '提现失败' });
  } finally {
    conn.release();
  }
});

router.get('/withdrawals', auth(['agent']), async (req, res) => {
  try {
    const [logs] = await pool.query(
      'SELECT id, amount, status, created_at FROM withdrawals WHERE agent_id=? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({
      withdrawLog: logs.map(w => ({
        id: w.id,
        date: formatDate(w.created_at),
        amount: Number(w.amount),
        status: statusText(w.status),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: '获取提现记录失败' });
  }
});

function formatDate(d) {
  const dt = new Date(d);
  const today = new Date();
  if (dt.toDateString() === today.toDateString()) return '今天';
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function statusText(s) {
  return { pending: '审核中', approved: '已通过', rejected: '已拒绝', paid: '已到账' }[s] || s;
}

module.exports = router;
