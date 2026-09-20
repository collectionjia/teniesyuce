/**
 * 网球对外下单/读数公共 helpers
 * - 页面：登录 JWT → 用当前用户钱包
 * - 对外：body.email / body.account 定位用户（无需 JWT）
 */
const pool = require('../db');
const btcWallet = require('./btcWallet');
const tennisDataSource = require('./tennisDataSource');
const { normalizePrivateKey, normalizeAddress } = require('./cryptoSecret');

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

async function resolveUserById(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [[row]] = await pool.query(
    'SELECT id, account FROM users WHERE id=? LIMIT 1',
    [id],
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

/**
 * 对外下单可直接带私钥和地址，覆盖账号里保存的钱包。
 * 两者都空则返回 null（走已保存钱包）；只填一个则 400。
 */
function walletOverrideFromBody(body = {}) {
  const privateKeyRaw = String(body.privateKey || body.private_key || '').trim();
  const addressRaw = String(
    body.address || body.proxyAddress || body.proxy_address || '',
  ).trim();
  if (!privateKeyRaw && !addressRaw) return null;
  if (!privateKeyRaw || !addressRaw) {
    const err = new Error('私钥和地址须同时填写');
    err.status = 400;
    throw err;
  }
  const sigRaw = body.signatureType ?? body.signature_type;
  // 3=POLY_1271 V2 存款钱包（新账户常用）；未传或非法时默认 3
  const signatureType = [0, 1, 2, 3].includes(Number(sigRaw)) ? Number(sigRaw) : 3;
  return {
    privateKey: normalizePrivateKey(privateKeyRaw),
    proxyAddress: normalizeAddress(addressRaw),
    signatureType,
  };
}

/**
 * 解析下单用户 → req.tennisUser
 * 优先 JWT（页面登录）；否则 body.email / body.account（对外 API）
 * 需配合 optionalAuth() 使用（有 token 时写入 req.user）
 */
async function attachUserFromEmailBody(req, res, next) {
  try {
    if (req.user?.id) {
      const user = await resolveUserById(req.user.id);
      if (!user) {
        return res.status(404).json({ ok: false, error: '登录用户不存在' });
      }
      req.tennisUser = user;
      return next();
    }

    const email = pickEmail(req.body);
    if (!email) {
      return res.status(400).json({
        ok: false,
        error: '请登录，或填写 email（或 account）',
      });
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
    req.walletOverride = null;
    if (!req.tradeSimulate) {
      req.walletOverride = walletOverrideFromBody(req.body);
    }
    if (req.tradeSimulate || req.walletOverride) return next();
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
  resolveUserById,
  resolveSimulate,
  ensureWalletForLive,
  walletOverrideFromBody,
  attachUserFromEmailBody,
  resolveTradeSimulatePublic,
};
