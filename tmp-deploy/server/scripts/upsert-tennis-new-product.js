/**
 * 注册 / 更新产品「新网球列表页」
 *
 *   cd server && node scripts/upsert-tennis-new-product.js
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
  name: '新网球列表页',
  tag: 'tennis-new',
  gradient: 'linear-gradient(135deg,#2563eb,#06b6d4)',
  url: '#',
  description: '排名前50运动员赛事列表，可按 Top20 / Top50 排名池筛选（任一方在该档内即显示）。',
  price_month: Number(process.env.TENNIS_NEW_PRICE_MONTH || 2),
  price_week: Number(process.env.TENNIS_NEW_PRICE_WEEK || 1),
  price_day: Number(process.env.TENNIS_NEW_PRICE_DAY || 0.5),
  default_plan: 'month',
  online: 1,
};

async function main() {
  try {
    await pool.query('ALTER TABLE products MODIFY tag VARCHAR(32) NULL');
  } catch (e) {
    /* ignore if already wide enough */
  }

  const [[byName]] = await pool.query(
    `SELECT id, name, url FROM products
     WHERE LOWER(COALESCE(tag,'')) = 'tennis-new'
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
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
