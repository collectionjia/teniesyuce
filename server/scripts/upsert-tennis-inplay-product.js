/**
 * 注册 / 更新产品「盘中采集」（仅管理员可见）
 *
 *   cd server && FORCE_PRODUCT_UPSERT=1 node scripts/upsert-tennis-inplay-product.js
 */
require('dotenv').config({
  path: process.env.ENV_FILE
    ? require('path').resolve(process.cwd(), process.env.ENV_FILE)
    : require('path').join(__dirname, '..', '.env'),
  override: true,
});
if (!process.env.ENV_FILE) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
}

const pool = require('../src/db');
const productService = require('../src/services/product');

const PRODUCT = {
  name: '盘中采集',
  tag: 'tennis-inplay',
  gradient: 'linear-gradient(135deg,#b45309,#f59e0b)',
  url: '#',
  description: 'collect_live 盘中数据预览（仅管理员可见）。默认前 3 场进行中，可用 --filter=true 启用 tier/Top100。',
  price_month: 0,
  price_week: 0,
  price_day: 0,
  default_plan: 'month',
  online: 1,
  admin_only: 1,
};

async function main() {
  await productService.ensureProductColumns();
  try {
    await pool.query('ALTER TABLE products MODIFY tag VARCHAR(32) NULL');
  } catch (e) {
    /* ignore */
  }

  const [rows] = await pool.query(
    `SELECT id, name, url FROM products
     WHERE LOWER(COALESCE(tag,'')) = 'tennis-inplay'
     ORDER BY id ASC
     LIMIT 1`,
  );
  const existing = rows[0];

  if (existing) {
    await pool.query(
      `UPDATE products SET name=?, tag=?, gradient=?, url=?, description=?,
       price_month=?, price_week=?, price_day=?, default_plan=?, online=?, admin_only=? WHERE id=?`,
      [
        PRODUCT.name,
        PRODUCT.tag,
        PRODUCT.gradient,
        PRODUCT.url,
        PRODUCT.description,
        PRODUCT.price_month,
        PRODUCT.price_week,
        PRODUCT.price_day,
        PRODUCT.default_plan,
        PRODUCT.online,
        PRODUCT.admin_only,
        existing.id,
      ],
    );
    console.log(`已更新产品 #${existing.id}「${PRODUCT.name}」（admin_only=1）`);
  } else if (process.env.FORCE_PRODUCT_UPSERT === '1' || process.argv.includes('--create')) {
    const [result] = await pool.query(
      `INSERT INTO products
       (name, tag, gradient, url, description, price_month, price_week, price_day, default_plan, online, admin_only)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        PRODUCT.name,
        PRODUCT.tag,
        PRODUCT.gradient,
        PRODUCT.url,
        PRODUCT.description,
        PRODUCT.price_month,
        PRODUCT.price_week,
        PRODUCT.price_day,
        PRODUCT.default_plan,
        PRODUCT.online,
        PRODUCT.admin_only,
      ],
    );
    console.log(`已创建产品 #${result.insertId}「${PRODUCT.name}」（admin_only=1）`);
  } else {
    console.log('未找到已有「盘中采集」产品，跳过创建。首次请: FORCE_PRODUCT_UPSERT=1 node scripts/upsert-tennis-inplay-product.js');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
