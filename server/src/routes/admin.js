const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const settings = require('../services/settings');
const productService = require('../services/product');
const userService = require('../services/user');
const { fulfillSubscription, setSubscriptionExpiry, revokeSubscription } = require('../services/subscription');
const redeemCodeService = require('../services/redeemCode');

const router = express.Router();

function genInviteCode() {
  return 'AGENT-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function mapProduct(p) {
  return productService.mapProductRow(p);
}

router.get('/stats', auth(['admin']), async (req, res) => {
  try {
    const [[{ userCount }]] = await pool.query("SELECT COUNT(*) AS userCount FROM users WHERE role='user'");
    const [[{ agentCount }]] = await pool.query("SELECT COUNT(*) AS agentCount FROM users WHERE role='agent'");
    const [[{ monthRevenue }]] = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS monthRevenue FROM orders WHERE MONTH(created_at)=MONTH(CURDATE())'
    );
    const [[{ activeSubs }]] = await pool.query(
      'SELECT COUNT(*) AS activeSubs FROM subscriptions WHERE expiry_at > NOW()'
    );

    const [revRows] = await pool.query(
      `SELECT DATE(created_at) AS d, SUM(amount) AS v FROM orders
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(created_at) ORDER BY d`
    );

    const revenue = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = revRows.find(r => new Date(r.d).toISOString().slice(0, 10) === key);
      revenue.push(found ? Number(found.v) : 0);
    }

    res.json({
      stats: [
        { label: '注册用户', value: userCount.toLocaleString() },
        { label: '代理数量', value: String(agentCount) },
        { label: '本月营收', value: '¥' + (Number(monthRevenue) / 1000).toFixed(1) + 'k' },
        { label: '活跃订阅', value: String(activeSubs) },
      ],
      revenue,
    });
  } catch (e) {
    res.status(500).json({ error: '获取统计失败' });
  }
});

function toDateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

router.get('/daily-report', auth(['admin']), async (req, res) => {
  try {
    await redeemCodeService.ensureTable();
    let date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [[today]] = await pool.query('SELECT CURDATE() AS d');
      date = toDateKey(today.d);
    }

    const [[{ newUsers }]] = await pool.query(
      "SELECT COUNT(*) AS newUsers FROM users WHERE role='user' AND DATE(created_at)=?",
      [date]
    );
    const [[{ redeemActivated }]] = await pool.query(
      "SELECT COUNT(*) AS redeemActivated FROM redeem_codes WHERE status='used' AND DATE(redeemed_at)=?",
      [date]
    );
    const [[orderAgg]] = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS revenue,
              COALESCE(SUM(commission),0) AS commission,
              COUNT(*) AS orderCount
       FROM orders WHERE DATE(created_at)=?`,
      [date]
    );
    const [[{ paidAmount }]] = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS paidAmount FROM payment_orders
       WHERE status='paid' AND DATE(COALESCE(paid_at, created_at))=?`,
      [date]
    );

    const [trendRows] = await pool.query(
      `SELECT d.day AS day,
              COALESCE(u.new_users, 0) AS newUsers,
              COALESCE(r.redeem_activated, 0) AS redeemActivated,
              COALESCE(o.revenue, 0) AS revenue
       FROM (
         SELECT DATE(?) - INTERVAL n DAY AS day
         FROM (
           SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
           UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
         ) nums
       ) d
       LEFT JOIN (
         SELECT DATE(created_at) AS day, COUNT(*) AS new_users
         FROM users WHERE role='user' AND created_at >= DATE(?) - INTERVAL 6 DAY
           AND created_at < DATE(?) + INTERVAL 1 DAY
         GROUP BY DATE(created_at)
       ) u ON u.day = d.day
       LEFT JOIN (
         SELECT DATE(redeemed_at) AS day, COUNT(*) AS redeem_activated
         FROM redeem_codes
         WHERE status='used' AND redeemed_at >= DATE(?) - INTERVAL 6 DAY
           AND redeemed_at < DATE(?) + INTERVAL 1 DAY
         GROUP BY DATE(redeemed_at)
       ) r ON r.day = d.day
       LEFT JOIN (
         SELECT DATE(created_at) AS day, SUM(amount) AS revenue
         FROM orders
         WHERE created_at >= DATE(?) - INTERVAL 6 DAY
           AND created_at < DATE(?) + INTERVAL 1 DAY
         GROUP BY DATE(created_at)
       ) o ON o.day = d.day
       ORDER BY d.day DESC`,
      [date, date, date, date, date, date, date]
    );

    res.json({
      date,
      newUsers: Number(newUsers) || 0,
      redeemActivated: Number(redeemActivated) || 0,
      revenue: Number(orderAgg.revenue) || 0,
      commission: Number(orderAgg.commission) || 0,
      orderCount: Number(orderAgg.orderCount) || 0,
      paidAmount: Number(paidAmount) || 0,
      trend: (trendRows || []).map((row) => ({
        date: toDateKey(row.day),
        newUsers: Number(row.newUsers) || 0,
        redeemActivated: Number(row.redeemActivated) || 0,
        revenue: Number(row.revenue) || 0,
      })),
    });
  } catch (e) {
    console.error('[admin/daily-report]', e);
    res.status(500).json({ error: '获取日报失败' });
  }
});

router.get('/products', auth(['admin']), async (req, res) => {
  try {
    await productService.ensureProductColumns();
    const [rows] = await pool.query('SELECT * FROM products ORDER BY id');
    res.json({ products: rows.map(mapProduct) });
  } catch (e) {
    res.status(500).json({ error: '获取产品失败' });
  }
});

router.get('/products/:id', auth(['admin']), async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error: '产品不存在' });
    res.json({ product: mapProduct(p) });
  } catch (e) {
    res.status(500).json({ error: '获取产品失败' });
  }
});

router.post('/products', auth(['admin']), async (req, res) => {
  const { name, tag, gradient, url, desc, priceMonth, priceWeek, priceDay, online = true } = req.body;
  const defaultPlan = productService.pickDefaultPlan(req.body);
  if (!name || !tag) return res.status(400).json({ error: '请填写产品名称' });
  try {
    await productService.ensureProductColumns();
    const [result] = await pool.query(
      `INSERT INTO products (name, tag, gradient, url, description, price_month, price_week, price_day, default_plan, online)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [name, tag, gradient || 'linear-gradient(135deg,#2563eb,#06b6d4)', url || '#',
        desc || '', priceMonth || 0, priceWeek || 0, priceDay || 0, defaultPlan, online ? 1 : 0]
    );
    res.json({ id: result.insertId, message: '产品已创建' });
  } catch (e) {
    res.status(500).json({ error: '创建产品失败' });
  }
});

router.put('/products/:id', auth(['admin']), async (req, res) => {
  const { name, tag, gradient, url, desc, priceMonth, priceWeek, priceDay, online } = req.body;
  const defaultPlan = productService.pickDefaultPlan(req.body);
  try {
    await productService.ensureProductColumns();
    const [[exists]] = await pool.query('SELECT id FROM products WHERE id=?', [req.params.id]);
    if (!exists) return res.status(404).json({ error: '产品不存在' });
    await pool.query(
      `UPDATE products SET name=?, tag=?, gradient=?, url=?, description=?,
       price_month=?, price_week=?, price_day=?, default_plan=?, online=? WHERE id=?`,
      [name, tag, gradient, url, desc, priceMonth, priceWeek, priceDay, defaultPlan, online ? 1 : 0, req.params.id]
    );
    res.json({ message: '产品已更新' });
  } catch (e) {
    res.status(500).json({ error: '更新产品失败' });
  }
});

router.delete('/products/:id', auth(['admin']), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT id FROM products WHERE id=?', [req.params.id]);
    if (!p) {
      await conn.rollback();
      return res.status(404).json({ error: '产品不存在' });
    }
    await conn.query('DELETE FROM subscriptions WHERE product_id=?', [req.params.id]);
    await conn.query('DELETE FROM orders WHERE product_id=?', [req.params.id]);
    await conn.query('DELETE FROM products WHERE id=?', [req.params.id]);
    await conn.commit();
    res.json({ message: '产品已删除' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: '删除产品失败' });
  } finally {
    conn.release();
  }
});

router.get('/agents', auth(['admin']), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.account, u.name, u.invite_code, u.agent_status, u.commission_rate AS rate,
              u.withdrawable, u.month_commission AS commission,
              (SELECT COUNT(*) FROM users c WHERE c.agent_id=u.id) AS clients
       FROM users u WHERE u.role='agent' ORDER BY u.id`
    );
    res.json({
      agentList: rows.map(a => ({
        id: a.id,
        account: a.account,
        name: a.name,
        inviteCode: a.invite_code,
        agentStatus: a.agent_status,
        clients: a.clients,
        commission: Number(a.commission),
        withdrawable: Number(a.withdrawable),
        rate: Number(a.rate),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: '获取代理列表失败' });
  }
});

router.post('/agents', auth(['admin']), async (req, res) => {
  const { account, password, name, rate = 25 } = req.body;
  if (!account || !password || password.length < 6) {
    return res.status(400).json({ error: '请填写账号和密码（6位以上）' });
  }
  try {
    const [[exists]] = await pool.query('SELECT id FROM users WHERE account=?', [account.trim()]);
    if (exists) return res.status(400).json({ error: '账号已存在' });
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (account, password_hash, name, role, invite_code, agent_status, commission_rate)
       VALUES (?,?,?,?,?,?,?)`,
      [account.trim(), hash, name || account, 'agent', genInviteCode(), 'approved', rate]
    );
    res.json({ id: result.insertId, message: '代理已创建' });
  } catch (e) {
    res.status(500).json({ error: '创建代理失败' });
  }
});

router.put('/agents/:id', auth(['admin']), async (req, res) => {
  const { name, rate, agentStatus, password } = req.body;
  try {
    const [[agent]] = await pool.query('SELECT id FROM users WHERE id=? AND role=?', [req.params.id, 'agent']);
    if (!agent) return res.status(404).json({ error: '代理不存在' });
    if (rate !== undefined && (rate < 0 || rate > 100)) {
      return res.status(400).json({ error: '分成比例无效' });
    }
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name=?'); values.push(name); }
    if (rate !== undefined) { fields.push('commission_rate=?'); values.push(rate); }
    if (agentStatus !== undefined) { fields.push('agent_status=?'); values.push(agentStatus); }
    if (password && password.length >= 6) {
      fields.push('password_hash=?');
      values.push(await bcrypt.hash(password, 10));
    }
    if (fields.length === 0) return res.status(400).json({ error: '无更新内容' });
    values.push(req.params.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, values);
    res.json({ message: '代理已更新' });
  } catch (e) {
    res.status(500).json({ error: '更新代理失败' });
  }
});

router.delete('/agents/:id', auth(['admin']), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[agent]] = await conn.query('SELECT id FROM users WHERE id=? AND role=?', [req.params.id, 'agent']);
    if (!agent) {
      await conn.rollback();
      return res.status(404).json({ error: '代理不存在' });
    }
    await conn.query('UPDATE users SET agent_id=NULL WHERE agent_id=?', [req.params.id]);
    await conn.query('UPDATE orders SET agent_id=NULL WHERE agent_id=?', [req.params.id]);
    await conn.query('DELETE FROM withdrawals WHERE agent_id=?', [req.params.id]);
    await conn.query('DELETE FROM users WHERE id=?', [req.params.id]);
    await conn.commit();
    res.json({ message: '代理已删除' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: '删除代理失败' });
  } finally {
    conn.release();
  }
});

router.put('/agents/:id/rate', auth(['admin']), async (req, res) => {
  const { rate } = req.body;
  if (rate === undefined || rate < 0 || rate > 100) {
    return res.status(400).json({ error: '分成比例无效' });
  }
  try {
    await pool.query('UPDATE users SET commission_rate=? WHERE id=? AND role=?', [rate, req.params.id, 'agent']);
    res.json({ message: '分成比例已更新' });
  } catch (e) {
    res.status(500).json({ error: '更新失败' });
  }
});

router.get('/payment-orders', auth(['admin']), async (req, res) => {
  try {
    const { status } = req.query;
    let where = '';
    const params = [];
    if (status === 'paid') {
      where = "WHERE po.status='paid'";
    } else if (status === 'pending') {
      where = "WHERE po.status='pending'";
    } else if (status === 'unpaid') {
      where = "WHERE po.status IN ('pending','failed','cancelled')";
    }

    const [rows] = await pool.query(
      `SELECT po.id, po.reference, po.user_id, po.product_id, po.plan, po.amount, po.pay_amount,
              po.status, po.muskpay_tx_id, po.muskpay_status, po.created_at, po.paid_at,
              u.name AS user_name, u.account AS user_account,
              p.name AS product_name,
              a.id AS agent_id, a.name AS agent_name, a.invite_code AS agent_invite_code
       FROM payment_orders po
       JOIN users u ON po.user_id = u.id
       JOIN products p ON po.product_id = p.id
       LEFT JOIN users a ON u.agent_id = a.id AND a.role='agent'
       ${where}
       ORDER BY po.created_at DESC
       LIMIT 500`,
      params
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
        agentId: o.agent_id,
        agentName: o.agent_name || null,
        agentInviteCode: o.agent_invite_code || null,
        plan: o.plan,
        amount: Number(o.amount),
        payAmount: o.pay_amount,
        status: o.status,
        txId: o.muskpay_tx_id,
        muskpayStatus: o.muskpay_status,
        createdAt: o.created_at,
        paidAt: o.paid_at,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取订单失败' });
  }
});

router.get('/orders', auth(['admin']), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.id, o.user_id, o.product_id, u.name AS user, p.name AS product,
              o.plan, o.amount, o.commission, o.created_at
       FROM orders o
       JOIN users u ON o.user_id = u.id
       JOIN products p ON o.product_id = p.id
       ORDER BY o.created_at DESC LIMIT 200`
    );
    res.json({
      orders: rows.map(o => ({
        id: o.id,
        userId: o.user_id,
        productId: o.product_id,
        user: o.user,
        product: o.product,
        plan: o.plan,
        amount: Number(o.amount),
        commission: Number(o.commission),
        createdAt: o.created_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: '获取订单失败' });
  }
});

router.post('/orders', auth(['admin']), async (req, res) => {
  const { userId, productId, plan, amount } = req.body;
  if (!userId || !productId || !['month', 'week', 'day'].includes(plan)) {
    return res.status(400).json({ error: '参数错误' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.query(
      "SELECT id FROM users WHERE id=? AND role IN ('user','agent')",
      [userId]
    );
    const [[product]] = await conn.query('SELECT * FROM products WHERE id=?', [productId]);
    if (!user || !product) {
      await conn.rollback();
      return res.status(404).json({ error: '用户或产品不存在' });
    }

    const priceKey = { month: 'price_month', week: 'price_week', day: 'price_day' }[plan];
    const paidAmount = amount === '' || amount === undefined || amount === null
      ? Number(product[priceKey] || 0)
      : Number(amount);
    const recordAmount = Number.isFinite(paidAmount) && paidAmount >= 0 ? paidAmount : 0;

    const result = await fulfillSubscription(conn, userId, productId, plan, recordAmount);
    await conn.commit();

    res.json({
      message: result.message,
      expiry: result.expiry.getTime(),
      productName: product.name,
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: e.message || '创建订单失败' });
  } finally {
    conn.release();
  }
});

router.put('/orders/:id', auth(['admin']), async (req, res) => {
  const { plan, amount } = req.body;
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id=?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    await pool.query(
      'UPDATE orders SET plan=COALESCE(?, plan), amount=COALESCE(?, amount) WHERE id=?',
      [plan || null, amount ?? null, req.params.id]
    );
    res.json({ message: '订单已更新' });
  } catch (e) {
    res.status(500).json({ error: '更新订单失败' });
  }
});

router.delete('/orders/:id', auth(['admin']), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM orders WHERE id=?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: '订单不存在' });
    res.json({ message: '订单已删除' });
  } catch (e) {
    res.status(500).json({ error: '删除订单失败' });
  }
});

router.get('/users', auth(['admin']), async (req, res) => {
  try {
    await userService.ensureUserColumns();
    const [rows] = await pool.query(
      `SELECT u.id, u.account, u.name, u.role, u.balance, u.agent_id, u.tennis_filter_enabled, u.btc_sim_enabled, a.name AS agent_name
       FROM users u LEFT JOIN users a ON u.agent_id=a.id
       WHERE u.role IN ('user','agent') ORDER BY u.id DESC`
    );
    const userIds = rows.map((u) => u.id);
    const subMap = {};
    if (userIds.length) {
      const [subs] = await pool.query(
        `SELECT s.user_id, s.expiry_at, p.name AS product_name
         FROM subscriptions s
         JOIN products p ON p.id = s.product_id
         WHERE s.user_id IN (?)
         ORDER BY s.expiry_at DESC`,
        [userIds]
      );
      const now = new Date();
      for (const s of subs) {
        if (!subMap[s.user_id]) subMap[s.user_id] = [];
        subMap[s.user_id].push({
          productName: s.product_name,
          expiryAt: new Date(s.expiry_at).getTime(),
          active: new Date(s.expiry_at) > now,
        });
      }
    }
    res.json({
      users: rows.map(u => ({
        id: u.id,
        account: u.account,
        name: u.name,
        role: u.role,
        balance: Number(u.balance),
        agentId: u.agent_id,
        agentName: u.agent_name,
        tennisFilterEnabled: userService.mapTennisFilterEnabled(u),
        btcSimEnabled: userService.mapBtcSimEnabled(u),
        subscriptions: subMap[u.id] || [],
        activeSubCount: (subMap[u.id] || []).filter((s) => s.active).length,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: '获取用户失败' });
  }
});

router.post('/users', auth(['admin']), async (req, res) => {
  const { account, password, name, role = 'user', balance = 0, tennisFilterEnabled = false, btcSimEnabled = false } = req.body;
  if (!account || !password || password.length < 6) {
    return res.status(400).json({ error: '请填写账号和密码（6位以上）' });
  }
  if (!['user', 'agent'].includes(role)) {
    return res.status(400).json({ error: '角色无效' });
  }
  try {
    await userService.ensureUserColumns();
    const [[exists]] = await pool.query('SELECT id FROM users WHERE account=?', [account.trim()]);
    if (exists) return res.status(400).json({ error: '账号已存在' });
    const hash = await bcrypt.hash(password, 10);
    const invite = role === 'agent' ? genInviteCode() : null;
    const [result] = await pool.query(
      `INSERT INTO users (account, password_hash, name, role, balance, invite_code, agent_status, commission_rate, tennis_filter_enabled, btc_sim_enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [account.trim(), hash, name || account, role, balance, invite,
        role === 'agent' ? 'approved' : 'approved', role === 'agent' ? 25 : 0,
        tennisFilterEnabled ? 1 : 0, btcSimEnabled ? 1 : 0]
    );
    res.json({ id: result.insertId, message: '用户已创建' });
  } catch (e) {
    res.status(500).json({ error: '创建用户失败' });
  }
});

router.put('/users/:id', auth(['admin']), async (req, res) => {
  const { name, balance, password, role, tennisFilterEnabled, btcSimEnabled } = req.body;
  try {
    await userService.ensureUserColumns();
    const [[user]] = await pool.query('SELECT id, role FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.role === 'admin') return res.status(403).json({ error: '不能修改管理员账号' });
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name=?'); values.push(name); }
    if (balance !== undefined) { fields.push('balance=?'); values.push(balance); }
    if (role !== undefined && ['user', 'agent'].includes(role)) {
      fields.push('role=?');
      values.push(role);
    }
    if (tennisFilterEnabled !== undefined) {
      fields.push('tennis_filter_enabled=?');
      values.push(tennisFilterEnabled ? 1 : 0);
    }
    if (btcSimEnabled !== undefined) {
      fields.push('btc_sim_enabled=?');
      values.push(btcSimEnabled ? 1 : 0);
    }
    if (password && password.length >= 6) {
      fields.push('password_hash=?');
      values.push(await bcrypt.hash(password, 10));
    }
    if (fields.length === 0) return res.status(400).json({ error: '无更新内容' });
    values.push(req.params.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, values);
    res.json({ message: '用户已更新' });
  } catch (e) {
    res.status(500).json({ error: '更新用户失败' });
  }
});

/** 管理员重置用户/代理密码；可传 password，否则随机生成并返回明文一次 */
router.post('/users/:id/reset-password', auth(['admin']), async (req, res) => {
  try {
    const [[user]] = await pool.query(
      'SELECT id, role, account, name FROM users WHERE id=?',
      [req.params.id],
    );
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.role === 'admin') return res.status(403).json({ error: '不能重置管理员密码' });
    if (Number(user.id) === Number(req.user.id)) {
      return res.status(400).json({ error: '请使用「修改密码」修改自己的密码' });
    }

    let password = String(req.body?.password || '').trim();
    if (!password) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      let out = '';
      for (let i = 0; i < 8; i += 1) {
        out += chars[Math.floor(Math.random() * chars.length)];
      }
      password = out;
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hash, user.id]);
    res.json({
      message: '密码已重置',
      password,
      account: user.account,
      name: user.name,
    });
  } catch (e) {
    console.error('[admin/reset-password]', e.message || e);
    res.status(500).json({ error: '重置密码失败' });
  }
});

router.delete('/users/:id', auth(['admin']), async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: '不能删除当前登录账号' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[user]] = await conn.query('SELECT id, role FROM users WHERE id=?', [req.params.id]);
    if (!user) {
      await conn.rollback();
      return res.status(404).json({ error: '用户不存在' });
    }
    if (user.role === 'admin') {
      await conn.rollback();
      return res.status(403).json({ error: '不能删除管理员' });
    }
    await conn.query('UPDATE users SET agent_id=NULL WHERE agent_id=?', [req.params.id]);
    await conn.query('DELETE FROM subscriptions WHERE user_id=?', [req.params.id]);
    await conn.query('DELETE FROM orders WHERE user_id=?', [req.params.id]);
    await conn.query('DELETE FROM withdrawals WHERE agent_id=?', [req.params.id]);
    await conn.query('DELETE FROM users WHERE id=?', [req.params.id]);
    await conn.commit();
    res.json({ message: '用户已删除' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: '删除用户失败' });
  } finally {
    conn.release();
  }
});

router.get('/users/:id/subscriptions', auth(['admin']), async (req, res) => {
  try {
    const [[user]] = await pool.query(
      "SELECT id, name, account, role FROM users WHERE id=? AND role IN ('user','agent')",
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const [rows] = await pool.query(
      `SELECT s.product_id, s.expiry_at, p.name AS product_name
       FROM subscriptions s
       JOIN products p ON s.product_id = p.id
       WHERE s.user_id=?
       ORDER BY s.expiry_at DESC`,
      [req.params.id]
    );

    res.json({
      user: { id: user.id, name: user.name, account: user.account, role: user.role },
      subscriptions: rows.map((r) => ({
        productId: r.product_id,
        productName: r.product_name,
        expiryAt: new Date(r.expiry_at).getTime(),
        active: new Date(r.expiry_at) > new Date(),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取用户订阅失败' });
  }
});

router.post('/subscriptions/grant', auth(['admin']), async (req, res) => {
  const { userId, productId, plan, amount } = req.body;
  if (!userId || !productId || !['month', 'week', 'day'].includes(plan)) {
    return res.status(400).json({ error: '请选择用户、产品和订阅周期' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.query(
      "SELECT id FROM users WHERE id=? AND role IN ('user','agent')",
      [userId]
    );
    const [[product]] = await conn.query('SELECT * FROM products WHERE id=?', [productId]);
    if (!user) {
      await conn.rollback();
      return res.status(404).json({ error: '用户不存在' });
    }
    if (!product) {
      await conn.rollback();
      return res.status(404).json({ error: '产品不存在' });
    }

    const priceKey = { month: 'price_month', week: 'price_week', day: 'price_day' }[plan];
    const paidAmount = amount === '' || amount === undefined || amount === null
      ? 0
      : Number(amount);
    const recordAmount = Number.isFinite(paidAmount) && paidAmount >= 0
      ? paidAmount
      : Number(product[priceKey] || 0);

    const result = await fulfillSubscription(conn, userId, productId, plan, recordAmount);
    await conn.commit();

    res.json({
      message: `已为 ${product.name} 开通${plan === 'month' ? '月' : plan === 'week' ? '周' : '天'}套餐`,
      expiry: result.expiry.getTime(),
      productName: product.name,
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: e.message || '开通套餐失败' });
  } finally {
    conn.release();
  }
});

router.put('/users/:userId/subscriptions/:productId', auth(['admin']), async (req, res) => {
  const { expiryAt } = req.body;
  if (expiryAt === undefined || expiryAt === null || expiryAt === '') {
    return res.status(400).json({ error: '请设置到期时间' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await setSubscriptionExpiry(
      conn,
      req.params.userId,
      req.params.productId,
      new Date(expiryAt)
    );
    await conn.commit();
    res.json({
      message: `已更新 ${result.productName} 订阅到期时间`,
      expiryAt: result.expiry.getTime(),
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(400).json({ error: e.message || '更新订阅失败' });
  } finally {
    conn.release();
  }
});

router.delete('/users/:userId/subscriptions/:productId', auth(['admin']), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await revokeSubscription(conn, req.params.userId, req.params.productId);
    await conn.commit();
    res.json({ message: `已取消 ${result.productName} 订阅` });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(400).json({ error: e.message || '取消订阅失败' });
  } finally {
    conn.release();
  }
});

router.get('/settings/payment', auth(['admin']), async (_req, res) => {
  try {
    res.json(await settings.getPaymentSettings());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取支付设置失败' });
  }
});

router.put('/settings/payment', auth(['admin']), async (req, res) => {
  const { defaultPlan, redeemPurchaseUrl } = req.body || {};
  if (defaultPlan == null && redeemPurchaseUrl == null) {
    return res.status(400).json({ error: '请提供要保存的设置项' });
  }
  try {
    if (defaultPlan != null) {
      await settings.setDefaultPaymentPlan(defaultPlan);
    }
    if (redeemPurchaseUrl != null) {
      await settings.setRedeemPurchaseUrl(redeemPurchaseUrl);
    }
    res.json({ message: '设置已保存', ...(await settings.getPaymentSettings()) });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || '保存设置失败' });
  }
});

router.get('/withdrawals', auth(['admin']), async (req, res) => {
  try {
    const { status } = req.query;
    let clause = '';
    const params = [];
    if (status && status !== 'all') {
      clause = 'WHERE w.status = ?';
      params.push(status);
    }
    const [rows] = await pool.query(
      `SELECT w.id, w.agent_id, w.amount, w.status, w.created_at,
              u.name AS agent_name, u.account AS agent_account
       FROM withdrawals w
       JOIN users u ON w.agent_id = u.id
       ${clause}
       ORDER BY w.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({
      withdrawals: rows.map((w) => ({
        id: w.id,
        agentId: w.agent_id,
        agentName: w.agent_name,
        agentAccount: w.agent_account,
        amount: Number(w.amount),
        status: w.status,
        createdAt: w.created_at,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取提现申请失败' });
  }
});

router.post('/withdrawals/:id/pay', auth(['admin']), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[withdrawal]] = await conn.query(
      'SELECT id, agent_id, amount, status FROM withdrawals WHERE id=? FOR UPDATE',
      [req.params.id]
    );
    if (!withdrawal) {
      await conn.rollback();
      return res.status(404).json({ error: '提现申请不存在' });
    }
    if (withdrawal.status !== 'pending') {
      await conn.rollback();
      return res.status(400).json({ error: '该申请已处理' });
    }
    const [[agent]] = await conn.query(
      'SELECT name, account FROM users WHERE id=?',
      [withdrawal.agent_id]
    );
    await conn.query("UPDATE withdrawals SET status='paid' WHERE id=?", [withdrawal.id]);
    await conn.commit();
    const agentLabel = agent?.name || agent?.account || `代理#${withdrawal.agent_id}`;
    res.json({
      message: `已向 ${agentLabel} 确认打款 ¥${Number(withdrawal.amount).toFixed(2)}`,
      withdrawalId: withdrawal.id,
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: '确认打款失败' });
  } finally {
    conn.release();
  }
});

router.post('/redeem-codes/generate', auth(['admin']), async (req, res) => {
  try {
    const { productId, plan, count, expiresAt, expiresInDays } = req.body || {};
    const result = await redeemCodeService.generateCodes({
      productId,
      plan,
      count,
      expiresAt,
      expiresInDays,
      createdBy: req.user.id,
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || '生成失败' });
  }
});

router.get('/redeem-codes/batches', auth(['admin']), async (req, res) => {
  try {
    const batches = await redeemCodeService.listBatches({ limit: req.query.limit });
    res.json({ batches });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取批次失败' });
  }
});

router.get('/redeem-codes', auth(['admin']), async (req, res) => {
  try {
    const data = await redeemCodeService.listCodes({
      batchId: req.query.batchId,
      status: req.query.status,
      productId: req.query.productId,
      search: req.query.search || req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取兑换码失败' });
  }
});

router.get('/redeem-codes/export', auth(['admin']), async (req, res) => {
  try {
    const batchId = req.query.batchId;
    const items = await redeemCodeService.getCodesForExport(batchId);
    const xml = redeemCodeService.buildExcelXml(items);
    const filename = `redeem-${batchId || 'codes'}.xls`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || '导出失败' });
  }
});

router.post('/redeem-codes/:id/disable', auth(['admin']), async (req, res) => {
  try {
    const result = await redeemCodeService.disableCode(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || '移除失败' });
  }
});

router.delete('/redeem-codes/:id', auth(['admin']), async (req, res) => {
  try {
    const result = await redeemCodeService.deleteCode(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || '删除失败' });
  }
});

router.post('/redeem-codes/batches/:batchId/disable', auth(['admin']), async (req, res) => {
  try {
    const result = await redeemCodeService.disableBatch(req.params.batchId);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || '批量移除失败' });
  }
});

router.delete('/redeem-codes/batches/:batchId', auth(['admin']), async (req, res) => {
  try {
    const result = await redeemCodeService.deleteBatch(req.params.batchId);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || '批量删除失败' });
  }
});

module.exports = router;
