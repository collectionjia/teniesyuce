const pool = require('../db');

const PAYMENT_PLANS = ['month', 'week', 'day'];
let columnsReady = false;

async function ensureProductColumns() {
  if (columnsReady) return;
  try {
    await pool.query(
      "ALTER TABLE products ADD COLUMN default_plan ENUM('month','week','day') NOT NULL DEFAULT 'month'"
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  try {
    await pool.query(
      'ALTER TABLE products ADD COLUMN admin_only TINYINT(1) NOT NULL DEFAULT 0'
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  try {
    await pool.query('ALTER TABLE products ADD COLUMN condition_select JSON NULL');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  try {
    await pool.query('ALTER TABLE products ADD COLUMN betting_select JSON NULL');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  columnsReady = true;
}

function normalizePlan(plan) {
  return PAYMENT_PLANS.includes(plan) ? plan : 'month';
}

function parseSelectJson(raw) {
  if (raw == null || raw === '') return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((row, i) => {
      if (!row || typeof row !== 'object') return null;
      const id = row.id != null ? String(row.id).trim() : '';
      if (!id) return null;
      const join = String(row.joinPrev || 'or').toLowerCase();
      return {
        id,
        joinPrev: i === 0 ? 'or' : join === 'and' ? 'and' : 'or',
      };
    })
    .filter(Boolean);
}

function normalizeSelectInput(raw) {
  return parseSelectJson(Array.isArray(raw) ? raw : raw);
}

function mapProductRow(p) {
  return {
    id: p.id,
    name: p.name,
    tag: p.tag,
    gradient: p.gradient,
    url: p.url,
    desc: p.description,
    priceMonth: Number(p.price_month),
    priceWeek: Number(p.price_week),
    priceDay: Number(p.price_day),
    defaultPlan: normalizePlan(p.default_plan),
    online: !!p.online,
    adminOnly: !!p.admin_only,
    conditionSelect: parseSelectJson(p.condition_select),
    bettingSelect: parseSelectJson(p.betting_select),
  };
}

function pickDefaultPlan(body = {}) {
  return normalizePlan(body.defaultPlan);
}

function productBucket(product) {
  const tag = String(product?.tag || '').toLowerCase();
  const name = String(product?.name || '');
  if (tag === 'tennis-prematch' || /盘前网球/.test(name)) return 'prematch';
  if (tag === 'tennis-settled' || /盘后网球/.test(name)) return 'settled';
  if (tag === 'tennis-inplay' || (/盘中采集|盘中网球/.test(name) && !/盘前|盘后/.test(name))) return 'inplay';
  return null;
}

/** 取某桶第一个 online 网球产品（全局配置源） */
async function findOnlineProductForBucket(bucket) {
  await ensureProductColumns();
  const [rows] = await pool.query('SELECT * FROM products WHERE online=1 ORDER BY id ASC');
  for (const row of rows) {
    const mapped = mapProductRow(row);
    if (productBucket(mapped) === bucket) return mapped;
  }
  return null;
}

module.exports = {
  PAYMENT_PLANS,
  ensureProductColumns,
  normalizePlan,
  mapProductRow,
  pickDefaultPlan,
  parseSelectJson,
  normalizeSelectInput,
  productBucket,
  findOnlineProductForBucket,
};
