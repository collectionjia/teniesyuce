/**
 * 注册 / 更新产品：Dota2 Elo（iframe 嵌入 dota2elo 容器）
 *
 *   cd server && FORCE_PRODUCT_UPSERT=1 node scripts/upsert-dota2-product.js
 *   或：node scripts/upsert-dota2-product.js --create
 *
 * 环境变量：
 *   DOTA2ELO_PRODUCT_URL  产品外链（server 容器内可访问，默认 http://dota2elo:3001/）
 *   DOTA2_PRICE_MONTH / WEEK / DAY
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

const PRODUCTS = [
  {
    name: 'dota2赛事推荐',
    tag: 'dota2',
    gradient: 'linear-gradient(135deg,#b91c1c,#ea580c)',
    url: '#',
    description: 'Polymarket 未开赛对阵列表，订阅后可下单。',
    price_month: Number(process.env.DOTA2_PRICE_MONTH || 2),
    price_week: Number(process.env.DOTA2_PRICE_WEEK || 1),
    price_day: Number(process.env.DOTA2_PRICE_DAY || 0.5),
    default_plan: 'month',
    online: 1,
    legacyNameLike: '%Dota2%',
  },
  {
    name: 'nfl赛事推荐',
    tag: 'nfl',
    gradient: 'linear-gradient(135deg,#1d4ed8,#0f766e)',
    url: '#',
    description: 'Polymarket 未开赛对阵列表，订阅后可下单。',
    price_month: Number(process.env.NFL_PRICE_MONTH || 2),
    price_week: Number(process.env.NFL_PRICE_WEEK || 1),
    price_day: Number(process.env.NFL_PRICE_DAY || 0.5),
    default_plan: 'month',
    online: 1,
    legacyNameLike: 'NFL',
  },
];

async function upsertOne(p) {
  const [rows] = await pool.query(
    `SELECT id, name, tag FROM products
     WHERE LOWER(COALESCE(tag,'')) = ?
        OR name = ?
        OR name LIKE ?
     ORDER BY
       CASE WHEN LOWER(COALESCE(tag,'')) = ? THEN 0
            WHEN name = ? THEN 1
            ELSE 2 END,
       id ASC
     LIMIT 1`,
    [p.tag, p.name, p.legacyNameLike || p.name, p.tag, p.name],
  );
  const existing = rows[0];
  const vals = [
    p.name,
    p.tag,
    p.gradient,
    p.url,
    p.description,
    p.price_month,
    p.price_week,
    p.price_day,
    p.default_plan,
    p.online,
  ];

  if (existing) {
    await pool.query(
      `UPDATE products SET name=?, tag=?, gradient=?, url=?, description=?,
       price_month=?, price_week=?, price_day=?, default_plan=?, online=? WHERE id=?`,
      [...vals, existing.id],
    );
    console.log(`已更新 #${existing.id}「${p.name}」tag=${p.tag} url=${p.url}`);
    return;
  }

  if (process.env.FORCE_PRODUCT_UPSERT === '1' || process.argv.includes('--create')) {
    const [result] = await pool.query(
      `INSERT INTO products
       (name, tag, gradient, url, description, price_month, price_week, price_day, default_plan, online)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      vals,
    );
    console.log(`已创建 #${result.insertId}「${p.name}」tag=${p.tag} url=${p.url}`);
    return;
  }

  console.log(
    `未找到「${p.name}」，跳过创建。首次请: FORCE_PRODUCT_UPSERT=1 node scripts/upsert-dota2-product.js`,
  );
}

async function main() {
  try {
    await pool.query('ALTER TABLE products MODIFY tag VARCHAR(32) NULL');
  } catch {
    /* ignore */
  }
  for (const p of PRODUCTS) await upsertOne(p);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
