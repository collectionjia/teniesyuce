const crypto = require('crypto');
const pool = require('../db');
const { fulfillSubscription } = require('./subscription');

const PLANS = ['month', 'week', 'day'];
const PLAN_LABEL = { month: '月', week: '周', day: '天' };
/** product_id = 0 表示全部产品通用兑换码 */
const ALL_PRODUCTS_ID = 0;

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      code VARCHAR(32) NOT NULL UNIQUE,
      product_id INT NOT NULL DEFAULT 0,
      plan ENUM('month','week','day') NOT NULL,
      batch_id VARCHAR(64) NOT NULL,
      status ENUM('unused','used','disabled') NOT NULL DEFAULT 'unused',
      expires_at DATETIME NULL,
      redeemed_by INT NULL,
      redeemed_at DATETIME NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_batch (batch_id),
      INDEX idx_status (status),
      INDEX idx_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try {
    await pool.query('ALTER TABLE redeem_codes ADD COLUMN expires_at DATETIME NULL AFTER status');
  } catch (e) {
    if (!(e && String(e.message || '').includes('Duplicate column'))) {
      /* ignore existing */
    }
  }
  tableReady = true;
}

function normalizePlan(plan) {
  return PLANS.includes(plan) ? plan : null;
}

function parseProductId(productId) {
  if (productId === 'all' || productId === 'ALL' || productId === 0 || productId === '0') {
    return ALL_PRODUCTS_ID;
  }
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 0) return null;
  return Math.floor(pid);
}

function genCode() {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `YC-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function genBatchId() {
  const d = new Date();
  const ts = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
  return `B${ts}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function mapRow(r) {
  const expired = !!(r.expires_at && new Date(r.expires_at) <= new Date() && r.status === 'unused');
  return {
    id: r.id,
    code: r.code,
    productId: Number(r.product_id) || 0,
    productName: Number(r.product_id) === ALL_PRODUCTS_ID
      ? '全部产品'
      : (r.product_name || ''),
    allProducts: Number(r.product_id) === ALL_PRODUCTS_ID,
    plan: r.plan,
    planLabel: PLAN_LABEL[r.plan] || r.plan,
    batchId: r.batch_id,
    status: r.status,
    statusLabel: expired
      ? '已过期'
      : ({ unused: '未使用', used: '已兑换', disabled: '已移除' }[r.status] || r.status),
    expired,
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
    redeemedBy: r.redeemed_by,
    redeemedByName: r.redeemed_by_name || '',
    redeemedAt: r.redeemed_at ? new Date(r.redeemed_at).getTime() : null,
    createdBy: r.created_by,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
  };
}

function parseExpiresAt(expiresAt, expiresInDays) {
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const days = Number(expiresInDays);
  if (Number.isFinite(days) && days > 0) {
    return new Date(Date.now() + Math.floor(days) * 86400000);
  }
  return null;
}

async function generateCodes({ productId, plan, count, createdBy, expiresAt, expiresInDays }) {
  await ensureTable();
  const normalizedPlan = normalizePlan(plan);
  if (!normalizedPlan) throw Object.assign(new Error('套餐类型无效'), { status: 400 });
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1 || n > 500) {
    throw Object.assign(new Error('生成数量需在 1–500'), { status: 400 });
  }
  const pid = parseProductId(productId);
  if (pid == null) throw Object.assign(new Error('请选择产品'), { status: 400 });

  let productName = '全部产品';
  if (pid !== ALL_PRODUCTS_ID) {
    const [[product]] = await pool.query('SELECT id, name FROM products WHERE id=?', [pid]);
    if (!product) throw Object.assign(new Error('产品不存在'), { status: 404 });
    productName = product.name;
  }

  const expiry = parseExpiresAt(expiresAt, expiresInDays);
  const batchId = genBatchId();
  const codes = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < n; i++) {
      let code = genCode();
      let inserted = false;
      for (let retry = 0; retry < 5 && !inserted; retry++) {
        try {
          await conn.query(
            `INSERT INTO redeem_codes (code, product_id, plan, batch_id, expires_at, created_by)
             VALUES (?,?,?,?,?,?)`,
            [code, pid, normalizedPlan, batchId, expiry, createdBy || null],
          );
          codes.push(code);
          inserted = true;
        } catch (e) {
          if (e && e.code === 'ER_DUP_ENTRY') {
            code = genCode();
          } else {
            throw e;
          }
        }
      }
      if (!inserted) throw new Error('生成兑换码失败，请重试');
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return {
    batchId,
    productId: pid,
    productName,
    allProducts: pid === ALL_PRODUCTS_ID,
    plan: normalizedPlan,
    planLabel: PLAN_LABEL[normalizedPlan],
    expiresAt: expiry ? expiry.getTime() : null,
    count: codes.length,
    codes,
  };
}

async function listCodes({ batchId, status, productId, search, limit = 100, offset = 0 } = {}) {
  await ensureTable();
  const where = [];
  const params = [];
  if (batchId) {
    where.push('rc.batch_id=?');
    params.push(batchId);
  }
  if (status && ['unused', 'used', 'disabled'].includes(status)) {
    where.push('rc.status=?');
    params.push(status);
  }
  if (productId !== undefined && productId !== '' && productId !== null) {
    const pid = parseProductId(productId);
    if (pid != null) {
      where.push('rc.product_id=?');
      params.push(pid);
    }
  }
  const q = String(search || '').trim();
  if (q) {
    where.push('rc.code LIKE ?');
    params.push(`%${q.toUpperCase().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM redeem_codes rc ${whereSql}`,
    params,
  );
  const [rows] = await pool.query(
    `SELECT rc.*, p.name AS product_name, u.name AS redeemed_by_name
     FROM redeem_codes rc
     LEFT JOIN products p ON p.id = rc.product_id AND rc.product_id > 0
     LEFT JOIN users u ON u.id = rc.redeemed_by
     ${whereSql}
     ORDER BY rc.id DESC
     LIMIT ? OFFSET ?`,
    [...params, lim, off],
  );
  return { total: Number(total) || 0, items: rows.map(mapRow) };
}

async function listBatches({ limit = 50 } = {}) {
  await ensureTable();
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const [rows] = await pool.query(
    `SELECT rc.batch_id,
            rc.product_id,
            p.name AS product_name,
            rc.plan,
            COUNT(*) AS total,
            SUM(rc.status='unused') AS unused_count,
            SUM(rc.status='used') AS used_count,
            SUM(rc.status='disabled') AS disabled_count,
            MIN(rc.created_at) AS created_at,
            MIN(rc.expires_at) AS expires_at
     FROM redeem_codes rc
     LEFT JOIN products p ON p.id = rc.product_id AND rc.product_id > 0
     GROUP BY rc.batch_id, rc.product_id, p.name, rc.plan
     ORDER BY MIN(rc.created_at) DESC
     LIMIT ?`,
    [lim],
  );
  return rows.map((r) => ({
    batchId: r.batch_id,
    productId: Number(r.product_id) || 0,
    productName: Number(r.product_id) === ALL_PRODUCTS_ID ? '全部产品' : (r.product_name || ''),
    allProducts: Number(r.product_id) === ALL_PRODUCTS_ID,
    plan: r.plan,
    planLabel: PLAN_LABEL[r.plan] || r.plan,
    total: Number(r.total),
    unused: Number(r.unused_count),
    used: Number(r.used_count),
    disabled: Number(r.disabled_count),
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
  }));
}

async function getCodesForExport(batchId) {
  await ensureTable();
  if (!batchId) throw Object.assign(new Error('缺少批次号'), { status: 400 });
  const [rows] = await pool.query(
    `SELECT rc.*, p.name AS product_name
     FROM redeem_codes rc
     LEFT JOIN products p ON p.id = rc.product_id AND rc.product_id > 0
     WHERE rc.batch_id=?
     ORDER BY rc.id ASC`,
    [batchId],
  );
  if (!rows.length) throw Object.assign(new Error('批次不存在或为空'), { status: 404 });
  return rows.map(mapRow);
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SpreadsheetML (.xls)，Excel 可直接打开，无需额外依赖 */
function buildExcelXml(items) {
  const header = ['兑换码', '产品', '套餐', '状态', '过期时间', '批次号', '创建时间'];
  const rows = items.map((it) => [
    it.code,
    it.productName,
    it.planLabel,
    it.statusLabel,
    it.expiresAt ? new Date(it.expiresAt).toISOString().replace('T', ' ').slice(0, 19) : '',
    it.batchId,
    it.createdAt ? new Date(it.createdAt).toISOString().replace('T', ' ').slice(0, 19) : '',
  ]);
  const all = [header, ...rows];
  const xmlRows = all.map((cols) => {
    const cells = cols.map((c) => `<Cell><Data ss:Type="String">${escapeXml(c)}</Data></Cell>`).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="兑换码">
  <Table>${xmlRows}</Table>
 </Worksheet>
</Workbook>`;
}

/**
 * @param {number} userId
 * @param {string} rawCode
 * @param {{ productId?: number|string|null }} [opts]
 */
async function redeemCode(userId, rawCode, opts = {}) {
  await ensureTable();
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) throw Object.assign(new Error('请输入兑换码'), { status: 400 });

  const requestedProductId = opts.productId != null && opts.productId !== ''
    ? Number(opts.productId)
    : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      'SELECT * FROM redeem_codes WHERE code=? FOR UPDATE',
      [code],
    );
    if (!row) {
      await conn.rollback();
      throw Object.assign(new Error('兑换码不存在'), { status: 404 });
    }
    if (row.status === 'used') {
      await conn.rollback();
      throw Object.assign(new Error('已兑换'), { status: 400 });
    }
    if (row.status === 'disabled') {
      await conn.rollback();
      throw Object.assign(new Error('兑换码已移除'), { status: 400 });
    }
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      await conn.rollback();
      throw Object.assign(new Error('过期'), { status: 400 });
    }

    const codeProductId = Number(row.product_id) || 0;
    let targetProductId;

    if (codeProductId === ALL_PRODUCTS_ID) {
      if (!requestedProductId || !(requestedProductId > 0)) {
        await conn.rollback();
        throw Object.assign(new Error('请选择要兑换的产品'), { status: 400 });
      }
      targetProductId = requestedProductId;
    } else {
      if (requestedProductId && requestedProductId > 0 && requestedProductId !== codeProductId) {
        await conn.rollback();
        throw Object.assign(new Error('兑换产品错误'), { status: 400 });
      }
      targetProductId = codeProductId;
    }

    const [[product]] = await conn.query(
      'SELECT id, name, price_month, price_week, price_day FROM products WHERE id=?',
      [targetProductId],
    );
    if (!product) {
      await conn.rollback();
      throw Object.assign(new Error('产品不存在'), { status: 404 });
    }

    const priceCol = { month: 'price_month', week: 'price_week', day: 'price_day' }[row.plan];
    const faceAmount = Math.max(0, Number(product[priceCol]) || 0);

    const result = await fulfillSubscription(conn, userId, targetProductId, row.plan, faceAmount);
    await conn.query(
      `UPDATE redeem_codes
       SET status='used', redeemed_by=?, redeemed_at=NOW()
       WHERE id=?`,
      [userId, row.id],
    );
    await conn.commit();

    let message = `兑换成功：${product.name} · ${PLAN_LABEL[row.plan]}卡`;
    if (result?.commission > 0) {
      message += `（代理佣金 ¥${Number(result.commission).toFixed(2)}）`;
    }

    return {
      ok: true,
      code,
      productId: targetProductId,
      productName: product.name,
      plan: row.plan,
      planLabel: PLAN_LABEL[row.plan],
      amount: faceAmount,
      commission: result?.commission || 0,
      expiryAt: result?.expiry ? new Date(result.expiry).getTime() : null,
      message,
    };
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

/** 移除：未使用码软禁用 */
async function disableCode(id) {
  await ensureTable();
  const [r] = await pool.query(
    `UPDATE redeem_codes SET status='disabled'
     WHERE id=? AND status='unused'`,
    [Number(id)],
  );
  if (!r.affectedRows) {
    throw Object.assign(new Error('只能移除未使用的兑换码'), { status: 400 });
  }
  return { ok: true, message: '已移除' };
}

/** 删除：物理删除 */
async function deleteCode(id) {
  await ensureTable();
  const [r] = await pool.query('DELETE FROM redeem_codes WHERE id=?', [Number(id)]);
  if (!r.affectedRows) {
    throw Object.assign(new Error('兑换码不存在'), { status: 404 });
  }
  return { ok: true, message: '已删除' };
}

/** 按批次批量移除未使用码 */
async function disableBatch(batchId) {
  await ensureTable();
  if (!batchId) throw Object.assign(new Error('缺少批次号'), { status: 400 });
  const [r] = await pool.query(
    `UPDATE redeem_codes SET status='disabled'
     WHERE batch_id=? AND status='unused'`,
    [batchId],
  );
  return { ok: true, affected: r.affectedRows, message: `已移除 ${r.affectedRows} 个未使用兑换码` };
}

/** 按批次物理删除 */
async function deleteBatch(batchId) {
  await ensureTable();
  if (!batchId) throw Object.assign(new Error('缺少批次号'), { status: 400 });
  const [r] = await pool.query('DELETE FROM redeem_codes WHERE batch_id=?', [batchId]);
  return { ok: true, affected: r.affectedRows, message: `已删除 ${r.affectedRows} 个兑换码` };
}

module.exports = {
  PLANS,
  PLAN_LABEL,
  ALL_PRODUCTS_ID,
  ensureTable,
  generateCodes,
  listCodes,
  listBatches,
  getCodesForExport,
  buildExcelXml,
  redeemCode,
  disableCode,
  deleteCode,
  disableBatch,
  deleteBatch,
};
