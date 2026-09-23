const pool = require('../db');

const PAYMENT_PLANS = ['month', 'week', 'day'];
const DEFAULT_PAYMENT_PLAN_KEY = 'default_payment_plan';
const REDEEM_PURCHASE_URL_KEY = 'redeem_purchase_url';
const DEFAULT_REDEEM_PURCHASE_URL = 'https://pay.ldxp.cn/shop/8GD17A0H';
const BTC_CRAWL_ENABLED_KEY = 'btc_crawl_enabled';
const BTC_CRAWL_FORCE_OFF_KEY = 'btc_crawl_force_off';
const SHOP_PROFIT_TICKER_KEY = 'shop_profit_ticker';
const DEFAULT_SHOP_PROFIT_TICKER = [
  { name: '张三', amount: 30 },
  { name: '李四', amount: 86 },
  { name: '王五', amount: 120 },
];

let tableReady = false;

function envCrawlEnabled() {
  const v = String(process.env.CRAWL_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

async function upsertSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [key, value]
  );
}

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value VARCHAR(512) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // allow longer URLs / JSON if table already existed with VARCHAR(255/512)
  try {
    await pool.query(
      'ALTER TABLE app_settings MODIFY setting_value TEXT NOT NULL'
    );
  } catch (_) { /* ignore */ }

  const defaults = [
    [DEFAULT_PAYMENT_PLAN_KEY, 'month'],
    [REDEEM_PURCHASE_URL_KEY, DEFAULT_REDEEM_PURCHASE_URL],
    [BTC_CRAWL_ENABLED_KEY, envCrawlEnabled() ? '1' : '0'],
    [BTC_CRAWL_FORCE_OFF_KEY, '0'],
    [SHOP_PROFIT_TICKER_KEY, JSON.stringify(DEFAULT_SHOP_PROFIT_TICKER)],
  ];
  for (const [key, value] of defaults) {
    const [[row]] = await pool.query(
      'SELECT setting_value FROM app_settings WHERE setting_key=?',
      [key]
    );
    if (!row) {
      await pool.query(
        'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)',
        [key, value]
      );
    }
  }
  tableReady = true;
}

function normalizePlan(plan) {
  return PAYMENT_PLANS.includes(plan) ? plan : 'month';
}

function normalizeRedeemPurchaseUrl(url) {
  const t = String(url || '').trim();
  if (!t) return DEFAULT_REDEEM_PURCHASE_URL;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    return u.toString();
  } catch {
    throw new Error('兑换码购买链接格式不正确，请填写 http(s) 地址');
  }
}

async function getDefaultPaymentPlan() {
  await ensureTable();
  const [[row]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [DEFAULT_PAYMENT_PLAN_KEY]
  );
  return normalizePlan(row?.setting_value);
}

async function setDefaultPaymentPlan(plan) {
  await ensureTable();
  const value = normalizePlan(plan);
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [DEFAULT_PAYMENT_PLAN_KEY, value]
  );
  return value;
}

async function getRedeemPurchaseUrl() {
  await ensureTable();
  const [[row]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [REDEEM_PURCHASE_URL_KEY]
  );
  const raw = String(row?.setting_value || '').trim();
  if (!raw) return DEFAULT_REDEEM_PURCHASE_URL;
  try {
    return normalizeRedeemPurchaseUrl(raw);
  } catch {
    return DEFAULT_REDEEM_PURCHASE_URL;
  }
}

async function setRedeemPurchaseUrl(url) {
  await ensureTable();
  const value = normalizeRedeemPurchaseUrl(url);
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [REDEEM_PURCHASE_URL_KEY, value]
  );
  return value;
}

async function getBtcCrawlEnabled() {
  await ensureTable();
  const [[forceOffRow]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [BTC_CRAWL_FORCE_OFF_KEY]
  );
  if (String(forceOffRow?.setting_value || '').trim() === '1') return false;

  const [[row]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [BTC_CRAWL_ENABLED_KEY]
  );
  const v = String(row?.setting_value || '').trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return envCrawlEnabled();
  return envCrawlEnabled();
}

async function setBtcCrawlEnabled(enabled) {
  await ensureTable();
  const value = enabled ? '1' : '0';
  await upsertSetting(BTC_CRAWL_ENABLED_KEY, value);
  await upsertSetting(BTC_CRAWL_FORCE_OFF_KEY, enabled ? '0' : '1');
  return !!enabled;
}

function normalizeShopProfitTicker(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [];
  const out = [];
  for (const row of list.slice(0, 30)) {
    const name = String(row?.name ?? row?.user ?? row?.account ?? '').trim().slice(0, 32);
    const amount = Number(row?.amount ?? row?.profit ?? row?.usd);
    if (!name || !Number.isFinite(amount)) continue;
    out.push({ name, amount: Math.round(amount * 100) / 100 });
  }
  return out;
}

async function getShopProfitTicker() {
  await ensureTable();
  const [[row]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [SHOP_PROFIT_TICKER_KEY]
  );
  if (!row?.setting_value) return DEFAULT_SHOP_PROFIT_TICKER.map((x) => ({ ...x }));
  const items = normalizeShopProfitTicker(row.setting_value);
  return items.length ? items : DEFAULT_SHOP_PROFIT_TICKER.map((x) => ({ ...x }));
}

async function setShopProfitTicker(raw) {
  await ensureTable();
  const items = normalizeShopProfitTicker(raw);
  await upsertSetting(SHOP_PROFIT_TICKER_KEY, JSON.stringify(items));
  return items;
}

async function getPaymentSettings() {
  const [defaultPlan, redeemPurchaseUrl, shopProfitTicker] = await Promise.all([
    getDefaultPaymentPlan(),
    getRedeemPurchaseUrl(),
    getShopProfitTicker(),
  ]);
  return {
    defaultPlan,
    redeemPurchaseUrl,
    shopProfitTicker,
    plans: PAYMENT_PLANS.map((id) => ({
      id,
      label: { month: '按月订阅', week: '按周订阅', day: '按天订阅' }[id],
    })),
  };
}

module.exports = {
  PAYMENT_PLANS,
  DEFAULT_REDEEM_PURCHASE_URL,
  DEFAULT_SHOP_PROFIT_TICKER,
  getDefaultPaymentPlan,
  setDefaultPaymentPlan,
  getRedeemPurchaseUrl,
  setRedeemPurchaseUrl,
  getBtcCrawlEnabled,
  setBtcCrawlEnabled,
  getShopProfitTicker,
  setShopProfitTicker,
  getPaymentSettings,
};
