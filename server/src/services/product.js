const pool = require('../db');

const PAYMENT_PLANS = ['month', 'week', 'day'];
let columnsReady = false;
let categoriesReady = false;

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
  try {
    await pool.query('ALTER TABLE products ADD COLUMN category_id INT NULL');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
  columnsReady = true;
}

async function ensureProductCategories() {
  if (categoriesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureProductColumns();
  categoriesReady = true;
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

function normalizeCategoryId(raw) {
  if (raw == null || raw === '' || raw === 'none' || raw === 'null') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function mapCategoryRow(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: Number(row.sort_order) || 0,
  };
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
    categoryId: normalizeCategoryId(p.category_id),
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

async function listCategories() {
  await ensureProductCategories();
  const [rows] = await pool.query(
    'SELECT id, name, sort_order FROM product_categories ORDER BY sort_order ASC, id ASC'
  );
  return rows.map(mapCategoryRow);
}

async function createCategory({ name, sortOrder } = {}) {
  await ensureProductCategories();
  const title = String(name || '').trim();
  if (!title) {
    const err = new Error('请填写分类名称');
    err.status = 400;
    throw err;
  }
  let order = Number(sortOrder);
  if (!Number.isFinite(order)) {
    const [[{ mx }]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM product_categories');
    order = (Number(mx) || 0) + 10;
  }
  const [result] = await pool.query(
    'INSERT INTO product_categories (name, sort_order) VALUES (?, ?)',
    [title, Math.round(order)]
  );
  return { id: result.insertId, name: title, sortOrder: Math.round(order) };
}

async function updateCategory(id, { name, sortOrder } = {}) {
  await ensureProductCategories();
  const cid = Number(id);
  if (!Number.isFinite(cid) || cid <= 0) {
    const err = new Error('分类不存在');
    err.status = 404;
    throw err;
  }
  const [[exists]] = await pool.query(
    'SELECT id, name, sort_order FROM product_categories WHERE id=? LIMIT 1',
    [cid]
  );
  if (!exists) {
    const err = new Error('分类不存在');
    err.status = 404;
    throw err;
  }
  const fields = [];
  const vals = [];
  if (name != null) {
    const title = String(name).trim();
    if (!title) {
      const err = new Error('请填写分类名称');
      err.status = 400;
      throw err;
    }
    fields.push('name=?');
    vals.push(title);
  }
  if (sortOrder != null && sortOrder !== '') {
    const order = Number(sortOrder);
    if (!Number.isFinite(order)) {
      const err = new Error('排序无效');
      err.status = 400;
      throw err;
    }
    fields.push('sort_order=?');
    vals.push(Math.round(order));
  }
  if (!fields.length) return mapCategoryRow(exists);
  vals.push(cid);
  await pool.query(`UPDATE product_categories SET ${fields.join(', ')} WHERE id=?`, vals);
  const [[row]] = await pool.query(
    'SELECT id, name, sort_order FROM product_categories WHERE id=? LIMIT 1',
    [cid]
  );
  return mapCategoryRow(row);
}

async function deleteCategory(id) {
  await ensureProductCategories();
  const cid = Number(id);
  if (!Number.isFinite(cid) || cid <= 0) {
    const err = new Error('分类不存在');
    err.status = 404;
    throw err;
  }
  const [[exists]] = await pool.query('SELECT id FROM product_categories WHERE id=? LIMIT 1', [cid]);
  if (!exists) {
    const err = new Error('分类不存在');
    err.status = 404;
    throw err;
  }
  await pool.query('UPDATE products SET category_id=NULL WHERE category_id=?', [cid]);
  await pool.query('DELETE FROM product_categories WHERE id=?', [cid]);
  return { ok: true };
}

async function resolveCategoryId(raw) {
  const cid = normalizeCategoryId(raw);
  if (cid == null) return null;
  await ensureProductCategories();
  const [[row]] = await pool.query('SELECT id FROM product_categories WHERE id=? LIMIT 1', [cid]);
  return row ? cid : null;
}

async function findProductById(id) {
  await ensureProductColumns();
  const pid = Number(id);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const [rows] = await pool.query('SELECT * FROM products WHERE id=? LIMIT 1', [pid]);
  return rows[0] ? mapProductRow(rows[0]) : null;
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
  ensureProductCategories,
  normalizePlan,
  normalizeCategoryId,
  mapProductRow,
  mapCategoryRow,
  pickDefaultPlan,
  parseSelectJson,
  normalizeSelectInput,
  productBucket,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  resolveCategoryId,
  findProductById,
  findOnlineProductForBucket,
};
