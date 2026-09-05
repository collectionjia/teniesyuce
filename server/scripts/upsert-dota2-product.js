/**
 * 注册 / 更新产品「DOTA2」— Polymarket Dota2 盘口（与 Elo「DOTA」区分）
 *
 *   cd server && ENV_FILE=.env.test node scripts/upsert-dota2-product.js
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
  name: 'DOTA2',
  tag: 'dota2',
  gradient: 'linear-gradient(135deg,#7c3aed,#2563eb)',
  url: process.env.DOTA2_PRODUCT_URL || 'http://dota2:8781/',
  description: 'Polymarket Dota2 赛事盘口：双方隐含价（¢）与外链，定时刷新。',
  price_month: Number(process.env.DOTA2_PRICE_MONTH || 2),
  price_week: Number(process.env.DOTA2_PRICE_WEEK || 1),
  price_day: Number(process.env.DOTA2_PRICE_DAY || 0.5),
  default_plan: 'month',
  online: 1,
};

async function main() {
  const [[byName]] = await pool.query(
    `SELECT id, name, url FROM products
     WHERE LOWER(COALESCE(tag,'')) = 'dota2'
        OR name = ?
        OR name = 'DOTA2'
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
    console.log(`已更新产品 #${byName.id}「${PRODUCT.name}」→ ${PRODUCT.url}`);
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
    console.log(`已创建产品 #${result.insertId}「${PRODUCT.name}」→ ${PRODUCT.url}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
