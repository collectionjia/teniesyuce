const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const userService = require('../services/user');
require('dotenv').config();

const router = express.Router();

function accountValid(a) {
  const t = (a || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function maskName(acc, suffix) {
  const t = (acc || '').trim();
  const base = t.includes('@') ? t.split('@')[0] : t.slice(-4);
  return (base || '用户') + suffix;
}

function genInviteCode() {
  return 'AGENT-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function userPayload(row) {
  return {
    id: row.id,
    account: row.account,
    name: row.name,
    role: row.role,
    balance: Number(row.balance),
    inviteCode: row.invite_code,
    agentId: row.agent_id,
    boundInviteCode: row.bound_invite_code || null,
    tennisFilterEnabled: userService.mapTennisFilterEnabled(row),
    btcSimEnabled: userService.mapBtcSimEnabled(row),
  };
}

router.post('/register', async (req, res) => {
  const { account, password, regRole = 'user', inviteCode = '' } = req.body;
  if (!accountValid(account) || !password || password.length < 6) {
    return res.status(400).json({ error: '请填写正确的邮箱和密码（6位以上）' });
  }
  const role = regRole === 'agent' ? 'agent' : 'user';
  const conn = await pool.getConnection();
  try {
    await userService.ensureUserColumns();
    const [[exists]] = await conn.query('SELECT id FROM users WHERE account=?', [account.trim()]);
    if (exists) return res.status(400).json({ error: '账号已存在' });

    let agentId = null;
    const code = (inviteCode || '').trim().toUpperCase();
    if (code && role === 'user') {
      const [[agent]] = await conn.query(
        "SELECT id FROM users WHERE invite_code=? AND role='agent' AND agent_status='approved'",
        [code]
      );
      if (!agent) return res.status(400).json({ error: '邀请码无效' });
      agentId = agent.id;
    }

    const hash = await bcrypt.hash(password, 10);
    const name = maskName(account, role === 'agent' ? '代理' : '用户');
    const invite = role === 'agent' ? genInviteCode() : null;
    const agentStatus = role === 'agent' ? 'pending' : 'approved';
    const commissionRate = role === 'agent' ? 25 : 0;

    const [result] = await conn.query(
      `INSERT INTO users (account, password_hash, name, role, invite_code, agent_id, agent_status, commission_rate)
       VALUES (?,?,?,?,?,?,?,?)`,
      [account.trim(), hash, name, role, invite, agentId, agentStatus, commissionRate]
    );

    const userId = result.insertId;
    const [[row]] = await conn.query(
      `SELECT u.*, a.invite_code AS bound_invite_code FROM users u
       LEFT JOIN users a ON u.agent_id = a.id WHERE u.id=?`,
      [userId]
    );

    const token = jwt.sign(
      { id: row.id, role: row.role, name: row.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    let msg = role === 'agent' ? '代理申请已提交，审核中' : '注册成功';
    if (agentId && code) msg += `（已绑定邀请码 ${code}）`;

    res.json({ token, user: userPayload(row), message: msg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '注册失败' });
  } finally {
    conn.release();
  }
});

router.post('/login', async (req, res) => {
  const { account, password } = req.body;
  if (!accountValid(account) || !password) {
    return res.status(400).json({ error: '请输入正确的邮箱和密码' });
  }
  try {
    await userService.ensureUserColumns();
    const [[row]] = await pool.query(
      `SELECT u.*, a.invite_code AS bound_invite_code FROM users u
       LEFT JOIN users a ON u.agent_id = a.id WHERE u.account=?`,
      [account.trim()]
    );
    if (!row) return res.status(401).json({ error: '账号或密码错误' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: '账号或密码错误' });

    const token = jwt.sign(
      { id: row.id, role: row.role, name: row.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: userPayload(row) });
  } catch (e) {
    console.error(e);
    const code = e?.code || '';
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(code)) {
      return res.status(503).json({ error: '数据库连接异常，请稍后重试' });
    }
    res.status(500).json({ error: '登录失败' });
  }
});

router.get('/me', auth(), async (req, res) => {
  try {
    await userService.ensureUserColumns();
    const [[row]] = await pool.query(
      `SELECT u.*, a.invite_code AS bound_invite_code FROM users u
       LEFT JOIN users a ON u.agent_id = a.id WHERE u.id=?`,
      [req.user.id]
    );
    if (!row) return res.status(404).json({ error: '用户不存在' });
    res.json({ user: userPayload(row) });
  } catch (e) {
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

router.post('/change-password', auth(), async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    const [result] = await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
    if (!result.affectedRows) return res.status(404).json({ error: '用户不存在' });
    res.json({ ok: true, message: '密码修改成功' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '修改密码失败' });
  }
});

module.exports = router;
