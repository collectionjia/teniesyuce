const pool = require('../db');
const {
  encryptText,
  decryptText,
  maskPrivateKey,
  normalizePrivateKey,
  normalizeAddress,
} = require('./cryptoSecret');

let columnsReady = false;

async function ensureWalletColumns() {
  if (columnsReady) return;
  const migrations = [
    'ALTER TABLE users ADD COLUMN pm_private_key_enc TEXT NULL',
    'ALTER TABLE users ADD COLUMN pm_proxy_address VARCHAR(66) NULL',
    'ALTER TABLE users ADD COLUMN pm_signature_type TINYINT NOT NULL DEFAULT 1',
  ];
  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
  }
  columnsReady = true;
}

async function userHasBtcSimAccess(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  await ensureWalletColumns();
  const [[row]] = await pool.query(
    'SELECT btc_sim_enabled FROM users WHERE id=?',
    [user.id]
  );
  return !!row?.btc_sim_enabled;
}

/** 钱包仅对已开通 BTC 虚拟投注的用户开放（不含管理员自动放行） */
async function userHasWalletAccess(user) {
  if (!user?.id) return false;
  await ensureWalletColumns();
  const [[row]] = await pool.query(
    'SELECT btc_sim_enabled FROM users WHERE id=?',
    [user.id]
  );
  return !!row?.btc_sim_enabled;
}

async function getWalletStatus(userId) {
  await ensureWalletColumns();
  const [[row]] = await pool.query(
    `SELECT pm_private_key_enc, pm_proxy_address, pm_signature_type
     FROM users WHERE id=?`,
    [userId]
  );
  if (!row) return { configured: false };
  const configured = !!row.pm_private_key_enc && !!row.pm_proxy_address;
  let maskedKey = '';
  if (row.pm_private_key_enc) {
    try {
      maskedKey = maskPrivateKey(decryptText(row.pm_private_key_enc));
    } catch {
      maskedKey = '****';
    }
  }
  return {
    configured,
    proxyAddress: row.pm_proxy_address || '',
    signatureType: Number(row.pm_signature_type || 1),
    maskedKey,
  };
}

async function saveWallet(userId, { privateKey, proxyAddress, signatureType }) {
  await ensureWalletColumns();
  const addr = normalizeAddress(proxyAddress);
  const sig = [0, 1, 2, 3].includes(Number(signatureType))
    ? Number(signatureType)
    : 1;

  if (privateKey && String(privateKey).trim()) {
    const pk = normalizePrivateKey(privateKey);
    await pool.query(
      `UPDATE users
       SET pm_private_key_enc=?, pm_proxy_address=?, pm_signature_type=?
       WHERE id=?`,
      [encryptText(pk), addr, sig, userId]
    );
  } else {
    const [[row]] = await pool.query(
      'SELECT pm_private_key_enc FROM users WHERE id=?',
      [userId]
    );
    if (!row?.pm_private_key_enc) {
      throw new Error('请填写私钥和钱包地址');
    }
    await pool.query(
      `UPDATE users
       SET pm_proxy_address=?, pm_signature_type=?
       WHERE id=?`,
      [addr, sig, userId]
    );
  }
  return getWalletStatus(userId);
}

async function clearWallet(userId) {
  await ensureWalletColumns();
  await pool.query(
    `UPDATE users
     SET pm_private_key_enc=NULL, pm_proxy_address=NULL, pm_signature_type=1
     WHERE id=?`,
    [userId]
  );
  return { configured: false, proxyAddress: '', signatureType: 1, maskedKey: '' };
}

async function loadWalletSecrets(userId) {
  await ensureWalletColumns();
  const [[row]] = await pool.query(
    `SELECT pm_private_key_enc, pm_proxy_address, pm_signature_type
     FROM users WHERE id=?`,
    [userId]
  );
  if (!row?.pm_private_key_enc || !row?.pm_proxy_address) {
    throw new Error('请先配置私钥和钱包地址');
  }
  return {
    privateKey: decryptText(row.pm_private_key_enc),
    proxyAddress: row.pm_proxy_address,
    signatureType: Number(row.pm_signature_type || 1),
  };
}

module.exports = {
  ensureWalletColumns,
  userHasBtcSimAccess,
  userHasWalletAccess,
  getWalletStatus,
  saveWallet,
  clearWallet,
  loadWalletSecrets,
};
