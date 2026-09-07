const crypto = require('crypto');

function getSecretKey() {
  const secret = process.env.BTC_WALLET_SECRET || process.env.JWT_SECRET || 'change-me-in-production';
  return crypto.scryptSync(String(secret), 'yuce-btc-wallet-v1', 32);
}

function encryptText(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSecretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptText(payload) {
  if (!payload) return null;
  const buf = Buffer.from(String(payload), 'base64');
  if (buf.length < 28) throw new Error('密文无效');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getSecretKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    const msg = String(e?.message || e);
    if (/unable to authenticate|Unsupported state/i.test(msg)) {
      throw new Error('已保存私钥无法解密，请重新输入私钥并点击「加密保存」');
    }
    throw e;
  }
}

function maskPrivateKey(pk) {
  const s = String(pk || '').replace(/^0x/i, '');
  if (s.length < 8) return '****';
  return `0x****${s.slice(-4)}`;
}

function normalizePrivateKey(pk) {
  const raw = String(pk || '').trim();
  const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('私钥格式无效（需要 64 位十六进制）');
  }
  return `0x${hex}`;
}

function normalizeAddress(addr) {
  const a = String(addr || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new Error('钱包地址格式无效');
  }
  return a;
}

module.exports = {
  encryptText,
  decryptText,
  maskPrivateKey,
  normalizePrivateKey,
  normalizeAddress,
};
