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
  columnsReady = true;
}

function normalizePlan(plan) {
  return PAYMENT_PLANS.includes(plan) ? plan : 'month';
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
  };
}

function pickDefaultPlan(body = {}) {
  return normalizePlan(body.defaultPlan);
}

module.exports = {
  PAYMENT_PLANS,
  ensureProductColumns,
  normalizePlan,
  mapProductRow,
  pickDefaultPlan,
};
