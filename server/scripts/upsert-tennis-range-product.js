/**
 * 注册 / 更新产品「区间网球」
 *
 *   cd server && node scripts/upsert-tennis-range-product.js
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
  name: '区间网球',
  tag: 'tennis-range',
  gradient: 'linear-gradient(135deg,#0f766e,#14b8a6)',
  url: '#',
  description: '任一方 Top100 场次，按强者排名分档现差：Top10≥10 / Top20≥20 / Top50≥50 / Top100≥100。',
  price_month: Number(process.env.TENNIS_RANGE_PRICE_MONTH || 2),
  price_week: Number(process.env.TENNIS_RANGE_PRICE_WEEK || 1),
  price_day: Number(process.env.TENNIS_RANGE_PRICE_DAY || 0.5),
  default_plan: 'month',
  online: 1,
};

async function main() {
  const [[byName]] = await pool.query(
    `SELECT id, name, url FROM products
     WHERE LOWER(COALESCE(tag,'')) = 'tennis-range'
        OR name = ?
     ORDER BY id LIMIT 1`,
    [PRODUCT.name],
  );

  if (byName) {
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
        byName.id,
      ],
    );
    console.log(`已更新产品 #${byName.id}「${PRODUCT.name}」`);
  } else {
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
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
