/**
 * 网球对外下单/读数公共 helpers（邮箱定位用户，无需 JWT）
 */
const pool = require('../db');
const btcWallet = require('./btcWallet');
const tennisDataSource = require('./tennisDataSource');

function pickEmail(body = {}) {
  const email = String(body.email || '').trim();
  if (email) return email;
  return String(body.account || '').trim();
}

function wantBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal;
  return v === true || v === 1 || v === '1' || v === 'true';
}

async function resolveUserByEmail(email) {
  const account = String(email || '').trim();
  if (!account) return null;
  const [[row]] = await pool.query(
    'SELECT id, account FROM users WHERE account=? LIMIT 1',
    [account],
  );
  return row || null;
}

async function resolveSimulate(bodySimulate) {
  const force = await tennisDataSource.shouldSimulateTrades();
  return force || wantBool(bodySimulate, false);
}

async function ensureWalletForLive(userId, simulate) {
  if (simulate) return;
  const status = await btcWallet.getWalletStatus(userId);
  if (!status?.configured) {
    const err = new Error('该用户未配置钱包');
    err.status = 400;
    throw err;
  }
  if (status.decryptFailed) {
    const err = new Error('该用户钱包解密失败，请重新保存私钥');
    err.status = 400;
    throw err;
  }
}

/** 从 body.email / body.account 解析用户，写入 req.tennisUser */
async function attachUserFromEmailBody(req, res, next) {
  try {
    const email = pickEmail(req.body);
    if (!email) {
      return res.status(400).json({ ok: false, error: '请填写 email（或 account）' });
    }
    const user = await resolveUserByEmail(email);
    if (!user) {
      return res.status(404).json({ ok: false, error: '邮箱对应用户不存在' });
    }
    req.tennisUser = user;
    next();
  } catch (e) {
    console.error('[tennisOrdersPublic/attachUser]', e);
    res.status(500).json({ ok: false, error: '用户解析失败' });
  }
}

/** 虚拟采集强制模拟；实盘须已配置钱包 */
async function resolveTradeSimulatePublic(req, res, next) {
  try {
    const forceSim = await tennisDataSource.shouldSimulateTrades();
    const wantSim = forceSim || wantBool(req.body?.simulate, false);
    req.tradeSimulate = wantSim;
    if (req.tradeSimulate) return next();
    if (!req.tennisUser?.id) {
      return res.status(400).json({ ok: false, error: '缺少用户' });
    }
    await ensureWalletForLive(req.tennisUser.id, false);
    next();
  } catch (e) {
    const status = e.status || 400;
    res.status(status).json({ ok: false, error: e.message || '交易模式校验失败' });
  }
}

module.exports = {
  pickEmail,
  wantBool,
  resolveUserByEmail,
  resolveSimulate,
  ensureWalletForLive,
  attachUserFromEmailBody,
  resolveTradeSimulatePublic,
};
