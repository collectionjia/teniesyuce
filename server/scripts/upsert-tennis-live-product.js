/**
 * 注册 / 更新产品「ATP · WTA 盘中」
 *
 *   cd server && node scripts/upsert-tennis-live-product.js
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

const PRODUCT = {
  name: 'ATP · WTA 盘中',
  tag: 'tennis-live',
  gradient: 'linear-gradient(135deg,#7c3aed,#a855f7)',
  url: '#',
  description: 'ATP · WTA Top100 进行中场次：Top10差≤20 / Top20差≤30 / Top50差≤50 / Top100差≤150。',
  price_month: Number(process.env.TENNIS_LIVE_PRICE_MONTH || 2),
  price_week: Number(process.env.TENNIS_LIVE_PRICE_WEEK || 1),
  price_day: Number(process.env.TENNIS_LIVE_PRICE_DAY || 0.5),
  default_plan: 'month',
  online: 1,
};

async function main() {
  try {
    await pool.query('ALTER TABLE products MODIFY tag VARCHAR(32) NULL');
  } catch (e) {
    /* ignore if already wide enough */
  }

  const [rows] = await pool.query(
    `SELECT id, name, url FROM products
     WHERE LOWER(COALESCE(tag,'')) = 'tennis-live'
        OR name = ?
        OR name LIKE '%盘中%'
     ORDER BY
       CASE WHEN LOWER(COALESCE(tag,'')) = 'tennis-live' THEN 0
            WHEN name = ? THEN 1
            ELSE 2 END,
       id ASC
     LIMIT 1`,
    [PRODUCT.name, PRODUCT.name],
  );
  const existing = rows[0];

  if (existing) {
    await pool.query(
      `UPDATE products SET name=?, tag=?, gradient=?, url=?, description=?,
       price_month=?, price_week=?, price_day=?, default_plan=?, online=? WHERE id=?`,
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
        existing.id,
      ],
    );
    console.log(`已更新产品 #${existing.id}「${PRODUCT.name}」`);
  } else if (process.env.FORCE_PRODUCT_UPSERT === '1' || process.argv.includes('--create')) {
    const [result] = await pool.query(
      `INSERT INTO products
       (name, tag, gradient, url, description, price_month, price_week, price_day, default_plan, online)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
      ],
    );
    console.log(`已创建产品 #${result.insertId}「${PRODUCT.name}」`);
  } else {
    console.log('未找到已有「盘中」产品，跳过创建（避免发版重复）。首次请: FORCE_PRODUCT_UPSERT=1 node scripts/upsert-tennis-live-product.js');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
