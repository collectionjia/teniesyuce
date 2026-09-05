/**
 * 注册 / 更新 YUCE 产品「DOTA」— 内嵌 dota2elo 服务（embed 代理）
 *
 * 用法:
 *   cd server
 *   node scripts/upsert-dota-product.js
 *
 * 环境变量:
 *   DOTA_PRODUCT_URL  Docker 内默认 http://dota:8777/
 *   DOTA_PRICE_MONTH / DOTA_PRICE_WEEK / DOTA_PRICE_DAY
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const pool = require('../src/db');

const PRODUCT = {
  name: 'DOTA',
  tag: 'dota',
  gradient: 'linear-gradient(135deg,#dc2626,#7c3aed)',
  url: process.env.DOTA_PRODUCT_URL || 'http://dota:8777/',
  description:
    'Dota2 职业战队 Elo 排行榜、对阵胜率预测、战队详情与 Polymarket 参考。',
  price_month: Number(process.env.DOTA_PRICE_MONTH || 2),
  price_week: Number(process.env.DOTA_PRICE_WEEK || 1),
  price_day: Number(process.env.DOTA_PRICE_DAY || 0.5),
  default_plan: 'month',
  online: 1,
};

async function main() {
  const [[byName]] = await pool.query(
    `SELECT id, name, url FROM products
     WHERE LOWER(COALESCE(tag,'')) = ?
        OR name = ?
        OR name LIKE ?
        OR LOWER(name) LIKE ?
     ORDER BY id LIMIT 1`,
    ['dota', PRODUCT.name, '%DOTA%', '%dota%']
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
      ]
    );
    console.log(`✅ 已更新产品 #${byName.id}「${PRODUCT.name}」→ ${PRODUCT.url}`);
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
      ]
    );
    console.log(`✅ 已创建产品 #${result.insertId}「${PRODUCT.name}」→ ${PRODUCT.url}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('❌', err.message || err);
  process.exit(1);
});
