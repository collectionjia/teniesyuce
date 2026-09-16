const pool = require('../db');

let ready = false;

async function ensureTradeRecordsTable() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      product VARCHAR(16) NOT NULL,
      action VARCHAR(8) NOT NULL,
      market VARCHAR(64) NULL,
      side VARCHAR(16) NULL,
      amount_usd DECIMAL(14,4) NULL,
      shares DECIMAL(18,6) NULL,
      price DECIMAL(12,6) NULL,
      label VARCHAR(255) NULL,
      order_id VARCHAR(128) NULL,
      ok TINYINT(1) NOT NULL DEFAULT 1,
      error_msg VARCHAR(512) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_trade_user_created (user_id, created_at),
      INDEX idx_trade_product (user_id, product, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
}

function clampPrice(p) {
  const n = Number(p);
  if (!(n > 0)) return null;
  if (n <= 1.05) return Math.round(Math.min(n, 1) * 1000) / 1000;
  if (n <= 100) return Math.round((n / 100) * 1000) / 1000;
  return null;
}

function priceFromFill(result, { action = 'buy', amountUsd } = {}) {
  const taking = Number(result?.takingAmount ?? result?.taking_amount);
  const making = Number(result?.makingAmount ?? result?.making_amount);
  if (taking > 0 && making > 0) {
    if (action === 'sell') {
      return clampPrice(taking / making) || clampPrice(making / taking);
    }
    return clampPrice(making / taking) || clampPrice(taking / making);
  }
  return clampPrice(result?.sellPrice ?? result?.price ?? result?.avgPrice)
    || (action === 'buy' && amountUsd > 0 && taking > 0
      ? clampPrice(amountUsd / taking)
      : null);
}

function sharesFromFill(result, { action = 'buy', amountUsd, price } = {}) {
  if (action === 'sell') {
    const sold = Number(result?.soldShares ?? result?.makingAmount ?? result?.making_amount);
    if (sold > 0) return Math.round(sold * 100) / 100;
  }
  const taking = Number(result?.takingAmount ?? result?.taking_amount);
  if (taking > 0 && action === 'buy') return Math.round(taking * 100) / 100;
  const p = Number(price);
  const usd = Number(amountUsd);
  if (p > 0 && usd > 0) return Math.round((usd / p) * 100) / 100;
  return null;
}

async function addTradeRecord(userId, row = {}) {
  await ensureTradeRecordsTable();
  const product = String(row.product || '').toLowerCase();
  const action = String(row.action || '').toLowerCase();
  if (
    !userId
    || !['btc', 'tennis', 'tennis-range', 'tennis-live', 'tennis-inplay', 'tennis-new', 'tennis-prematch', 'tennis-settled'].includes(product)
    || !['buy', 'sell'].includes(action)
  ) {
    return null;
  }
  const [ret] = await pool.query(
    `INSERT INTO trade_records
      (user_id, product, action, market, side, amount_usd, shares, price, label, order_id, ok, error_msg)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      userId,
      product,
      action,
      row.market ? String(row.market).slice(0, 64) : null,
      row.side ? String(row.side).slice(0, 16) : null,
      row.amountUsd != null && Number.isFinite(Number(row.amountUsd)) ? Number(row.amountUsd) : null,
      row.shares != null && Number.isFinite(Number(row.shares)) ? Number(row.shares) : null,
      row.price != null && Number.isFinite(Number(row.price)) ? Number(row.price) : null,
      row.label ? String(row.label).slice(0, 255) : null,
      row.orderId ? String(row.orderId).slice(0, 128) : null,
      row.ok === false ? 0 : 1,
      row.error ? String(row.error).slice(0, 512) : null,
    ]
  );
  return ret.insertId;
}

async function listTradeRecords(userId, { product = 'all', limit = 30, offset = 0, anyUser = false } = {}) {
  await ensureTradeRecordsTable();
  const lim = Math.min(200, Math.max(1, Number(limit) || 30));
  const off = Math.max(0, Number(offset) || 0);
  const params = [];
  let where = '1=1';
  if (!anyUser) {
    where = 'user_id=?';
    params.push(userId);
  } else if (userId) {
    where += ' AND user_id=?';
    params.push(userId);
  }
  if (product === 'tennis-family') {
    where += " AND product LIKE 'tennis%'";
  } else if (product && product !== 'all') {
    where += ' AND product=?';
    params.push(product);
  }
  const [rows] = await pool.query(
    `SELECT id, product, action, market, side, amount_usd, shares, price, label, order_id, ok, error_msg, created_at
     FROM trade_records
     WHERE ${where}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM trade_records WHERE ${where}`,
    params
  );
  return {
    total: Number(total) || 0,
    items: rows.map((r) => ({
      id: r.id,
      product: r.product,
      action: r.action,
      market: r.market || '',
      side: r.side || '',
      amountUsd: r.amount_usd != null ? Number(r.amount_usd) : null,
      shares: r.shares != null ? Number(r.shares) : null,
      price: r.price != null ? Number(r.price) : null,
      label: r.label || '',
      orderId: r.order_id || '',
      ok: !!r.ok,
      error: r.error_msg || '',
      createdAt: r.created_at,
    })),
  };
}

async function deleteTradeRecord(id, { userId = null, tennisOnly = true } = {}) {
  await ensureTradeRecordsTable();
  const rid = Number(id);
  if (!rid) return { deleted: 0 };
  const params = [rid];
  let where = 'id=?';
  if (userId) {
    where += ' AND user_id=?';
    params.push(userId);
  }
  if (tennisOnly) {
    where += " AND product LIKE 'tennis%'";
  }
  const [ret] = await pool.query(`DELETE FROM trade_records WHERE ${where}`, params);
  return { deleted: Number(ret.affectedRows) || 0 };
}

async function clearTradeRecords({ userId = null, product = 'tennis-family', anyUser = false } = {}) {
  await ensureTradeRecordsTable();
  const params = [];
  let where = '1=1';
  if (!anyUser) {
    if (!userId) return { deleted: 0 };
    where = 'user_id=?';
    params.push(userId);
  } else if (userId) {
    where += ' AND user_id=?';
    params.push(userId);
  }
  if (product === 'tennis-family') {
    where += " AND product LIKE 'tennis%'";
  } else if (product && product !== 'all') {
    where += ' AND product=?';
    params.push(product);
  }
  const [ret] = await pool.query(`DELETE FROM trade_records WHERE ${where}`, params);
  return { deleted: Number(ret.affectedRows) || 0 };
}

module.exports = {
  ensureTradeRecordsTable,
  addTradeRecord,
  listTradeRecords,
  deleteTradeRecord,
  clearTradeRecords,
  priceFromFill,
  sharesFromFill,
};
