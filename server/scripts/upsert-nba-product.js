/**
 * 注册 / 更新产品「NBA」— Polymarket NBA 盘口看板
 *
 *   cd server && ENV_FILE=.env.test node scripts/upsert-nba-product.js
 */
require('dotenv').config({
  path: process.env.ENV_FILE
    ? require('path').resolve(process.cwd(), process.env.ENV_FILE)
    : require('path').join(__dirname, '..', '.env'),
  override: true,
});
// 仅在未指定 ENV_FILE 时再读仓库根 .env
if (!process.env.ENV_FILE) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
}

const pool = require('../src/db');

const PRODUCT = {
  name: 'NBA',
  tag: 'nba',
  gradient: 'linear-gradient(135deg,#c2410c,#f97316)',
  url: process.env.NBA_PRODUCT_URL || 'http://basketball:8780/',
  description: 'Polymarket NBA 赛事盘口：双方隐含价（¢）与外链，定时刷新。',
  price_month: Number(process.env.NBA_PRICE_MONTH || 2),
  price_week: Number(process.env.NBA_PRICE_WEEK || 1),
  price_day: Number(process.env.NBA_PRICE_DAY || 0.5),
  default_plan: 'month',
  online: 1,
};

async function main() {
  const [[byName]] = await pool.query(
    `SELECT id, name, url FROM products
     WHERE LOWER(COALESCE(tag,'')) IN ('nba','basketball')
        OR name = ?
        OR name LIKE '%NBA%'
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
