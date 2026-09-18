/**
 * BTC 看板 API 密钥（Alchemy / Polymarket QUICK 账号）
 * 存 app_settings，密钥加密；GET 只返回是否已配置与掩码。
 */
const pool = require('../db');
const { encryptText, decryptText, maskPrivateKey, normalizePrivateKey, normalizeAddress } = require('./cryptoSecret');

const KEY = {
  alchemy: 'btc_alchemy_key',
  privateKey: 'btc_quick_private_key',
  funder: 'btc_quick_funder',
  relayerKey: 'btc_quick_relayer_key',
  relayerAddr: 'btc_quick_relayer_addr',
};

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try {
    await pool.query('ALTER TABLE app_settings MODIFY setting_value TEXT NOT NULL');
  } catch (_) { /* ignore */ }
  tableReady = true;
}

async function getRaw(key) {
  await ensureTable();
  const [[row]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=? LIMIT 1',
    [key],
  );
  return row?.setting_value != null ? String(row.setting_value) : '';
}

async function setRaw(key, value) {
  await ensureTable();
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [key, String(value ?? '')],
  );
}

function maskToken(s, n = 4) {
  const t = String(s || '');
  if (!t) return '';
  if (t.length <= n) return '****';
  return `****${t.slice(-n)}`;
}

function decryptOrEmpty(payload) {
  if (!payload) return '';
  try {
    return decryptText(payload) || '';
  } catch {
    return '';
  }
}

async function loadPlain() {
  const [alchemyEnc, pkEnc, funder, relayerEnc, relayerAddr] = await Promise.all([
    getRaw(KEY.alchemy),
    getRaw(KEY.privateKey),
    getRaw(KEY.funder),
    getRaw(KEY.relayerKey),
    getRaw(KEY.relayerAddr),
  ]);

  let alchemyKey = decryptOrEmpty(alchemyEnc);
  let privateKey = decryptOrEmpty(pkEnc);
  let relayerKey = decryptOrEmpty(relayerEnc);

  // 库为空时回退进程环境（兼容现有 server/.env）
  if (!alchemyKey) alchemyKey = String(process.env.ALCHEMY_KEY || '').trim();
  if (!privateKey) privateKey = String(process.env.QUICK_PRIVATE_KEY || '').trim();
  if (!relayerKey) relayerKey = String(process.env.QUICK_RELAYER_API_KEY || '').trim();

  let funderAddr = String(funder || '').trim();
  if (!funderAddr) funderAddr = String(process.env.QUICK_FUNDER || '').trim();

  let relayerAddress = String(relayerAddr || '').trim();
  if (!relayerAddress) {
    relayerAddress = String(process.env.QUICK_RELAYER_API_KEY_ADDRESS || '').trim();
  }

  return { alchemyKey, privateKey, funder: funderAddr, relayerKey, relayerAddr: relayerAddress };
}

async function getPublicStatus() {
  const plain = await loadPlain();
  return {
    alchemyKeySet: !!plain.alchemyKey,
    alchemyKeyMasked: plain.alchemyKey ? maskToken(plain.alchemyKey) : '',
    quickPrivateKeySet: !!plain.privateKey,
    quickPrivateKeyMasked: plain.privateKey ? maskPrivateKey(plain.privateKey) : '',
    quickFunder: plain.funder || '',
    quickRelayerKeySet: !!plain.relayerKey,
    quickRelayerKeyMasked: plain.relayerKey ? maskToken(plain.relayerKey) : '',
    quickRelayerAddr: plain.relayerAddr || '',
    urls: {
      clob: 'https://clob.polymarket.com',
      gamma: 'https://gamma-api.polymarket.com',
      alchemyRpc: 'https://polygon-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}',
    },
  };
}

/**
 * @param {object} body
 * 密钥字段留空 = 不修改；funder / relayerAddr 可写空串清空
 */
async function saveFromBody(body = {}) {
  const cur = await loadPlain();
  let alchemyKey = cur.alchemyKey;
  let privateKey = cur.privateKey;
  let funder = cur.funder;
  let relayerKey = cur.relayerKey;
  let relayerAddr = cur.relayerAddr;

  if (body.alchemyKey != null && String(body.alchemyKey).trim()) {
    alchemyKey = String(body.alchemyKey).trim();
  }
  if (body.quickPrivateKey != null && String(body.quickPrivateKey).trim()) {
    privateKey = normalizePrivateKey(body.quickPrivateKey);
  }
  if (body.quickFunder != null) {
    const raw = String(body.quickFunder).trim();
    funder = raw ? normalizeAddress(raw) : '';
  }
  if (body.quickRelayerKey != null && String(body.quickRelayerKey).trim()) {
    relayerKey = String(body.quickRelayerKey).trim();
  }
  if (body.quickRelayerAddr != null) {
    const raw = String(body.quickRelayerAddr).trim();
    relayerAddr = raw ? normalizeAddress(raw) : '';
  }

  await setRaw(KEY.alchemy, alchemyKey ? encryptText(alchemyKey) : '');
  await setRaw(KEY.privateKey, privateKey ? encryptText(privateKey) : '');
  await setRaw(KEY.funder, funder || '');
  await setRaw(KEY.relayerKey, relayerKey ? encryptText(relayerKey) : '');
  await setRaw(KEY.relayerAddr, relayerAddr || '');

  // 热更新本进程，供后续逻辑读取
  if (alchemyKey) process.env.ALCHEMY_KEY = alchemyKey;
  if (privateKey) process.env.QUICK_PRIVATE_KEY = privateKey;
  if (funder) process.env.QUICK_FUNDER = funder;
  else delete process.env.QUICK_FUNDER;
  if (relayerKey) process.env.QUICK_RELAYER_API_KEY = relayerKey;
  if (relayerAddr) process.env.QUICK_RELAYER_API_KEY_ADDRESS = relayerAddr;

  return getPublicStatus();
}

async function getPlainForBoardSync() {
  return loadPlain();
}

module.exports = {
  getPublicStatus,
  saveFromBody,
  getPlainForBoardSync,
};
