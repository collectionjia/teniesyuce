const crypto = require('crypto');
require('dotenv').config();

const API_BASE = process.env.MUSKPAY_API_BASE || 'https://apitest.nihaopay.com';
const BEARER_TOKEN = process.env.MUSKPAY_BEARER_TOKEN || '';
const CURRENCY = process.env.MUSKPAY_CURRENCY || 'USD';
const DEFAULT_VENDOR = process.env.MUSKPAY_VENDOR || 'alipay';

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase();
}

function verifySign(params, token = BEARER_TOKEN) {
  const sign = params.verify_sign;
  if (!sign) return false;
  const keys = Object.keys(params)
    .filter(k => k !== 'verify_sign' && params[k] != null && params[k] !== '')
    .sort();
  const str = keys.map(k => `${k}=${params[k]}`).join('&') + '&' + md5(token);
  return md5(str) === String(sign).toLowerCase();
}

function toRmbAmount(priceCny) {
  return Math.max(1, Math.round(Number(priceCny) * 100));
}

function flattenParams(params) {
  const flat = { ...params };
  if (Array.isArray(flat.items)) {
    flat.items.forEach((item, i) => {
      flat[`items[${i}][name]`] = item.name;
      flat[`items[${i}][unitAmount]`] = item.unitAmount;
      flat[`items[${i}][quantity]`] = item.quantity;
    });
    delete flat.items;
  }
  return flat;
}

async function createPayment(params) {
  if (!BEARER_TOKEN) {
    throw new Error('未配置 MUSKPAY_BEARER_TOKEN，请在 TMS 后台 设置 → 证书管理 获取');
  }

  const flat = flattenParams(params);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(flat)) {
    if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
  }

  const url = `${API_BASE}/v1.2/transactions/securepay`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || `NihaoPay 请求失败 (${res.status})`;
    const detail = data.label ? ` [${data.label}]` : '';
    console.error('NihaoPay securepay error:', res.status, JSON.stringify(data));
    throw new Error(msg + detail);
  }

  if (data.url) {
    return { redirectUrl: data.url, form: null };
  }
  if (data.form) {
    return { redirectUrl: null, form: data.form };
  }
  throw new Error('NihaoPay 未返回支付链接');
}

async function queryByReference(reference) {
  if (!BEARER_TOKEN) throw new Error('未配置 MUSKPAY_BEARER_TOKEN');
  const url = `${API_BASE}/v1.2/transactions/merchant/${encodeURIComponent(reference)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `查询交易失败 (${res.status})`);
  }
  return res.json();
}

function genReference() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return ('SUB' + ts + rnd).slice(0, 30);
}

module.exports = {
  verifySign,
  toRmbAmount,
  createPayment,
  queryByReference,
  genReference,
  CURRENCY,
  DEFAULT_VENDOR,
  API_BASE,
};
