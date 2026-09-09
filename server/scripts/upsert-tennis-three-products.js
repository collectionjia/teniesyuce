/**
 * 注册 / 更新三产品：盘前网球 / 盘中网球 / 盘后网球
 *
 *   cd server && FORCE_PRODUCT_UPSERT=1 node scripts/upsert-tennis-three-products.js
 *   或：node scripts/upsert-tennis-three-products.js --create
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
    name: '盘前网球',
    tag: 'tennis-prematch',
    gradient: 'linear-gradient(135deg,#0ea5e9,#2563eb)',
    url: '#',
    description: '今天未开赛 · 强者现排≤100；现差/排差/强现筛选；可手动或引擎投注。',
    price_month: Number(process.env.TENNIS_PREMATCH_PRICE_MONTH || 2),
    price_week: Number(process.env.TENNIS_PREMATCH_PRICE_WEEK || 1),
    price_day: Number(process.env.TENNIS_PREMATCH_PRICE_DAY || 0.5),
    default_plan: 'month',
    online: 1,
    legacyNameLike: '%盘前%',
  },
  {
    name: '盘中网球',
    tag: 'tennis-inplay',
    gradient: 'linear-gradient(135deg,#7c3aed,#a855f7)',
    url: '#',
    description: '进行中 Top100；§九 买入/止损；tick 刷 Polymarket 价。',
    price_month: Number(process.env.TENNIS_INPLAY_PRICE_MONTH || 2),
    price_week: Number(process.env.TENNIS_INPLAY_PRICE_WEEK || 1),
    price_day: Number(process.env.TENNIS_INPLAY_PRICE_DAY || 0.5),
    default_plan: 'month',
    online: 1,
    legacyTags: ['tennis-live', 'tennis-inplay'],
    legacyNameLike: '%盘中%',
  },
  {
    name: '盘后网球',
    tag: 'tennis-settled',
    gradient: 'linear-gradient(135deg,#64748b,#334155)',
    url: '#',
    description: '已结束场次列表 + 合计/盘前/盘中盈亏比（笔数口径）。',
    price_month: Number(process.env.TENNIS_SETTLED_PRICE_MONTH || 1),
    price_week: Number(process.env.TENNIS_SETTLED_PRICE_WEEK || 0.5),
    price_day: Number(process.env.TENNIS_SETTLED_PRICE_DAY || 0.2),
    default_plan: 'month',
    online: 1,
    legacyNameLike: '%盘后%',
  },
];

async function upsertOne(p) {
  const tagList = [p.tag, ...(p.legacyTags || [])].map((t) => String(t).toLowerCase());
  const placeholders = tagList.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT id, name, tag FROM products
     WHERE LOWER(COALESCE(tag,'')) IN (${placeholders})
        OR name = ?
        OR name LIKE ?
     ORDER BY
       CASE WHEN LOWER(COALESCE(tag,'')) = ? THEN 0
            WHEN name = ? THEN 1
            ELSE 2 END,
       id ASC
     LIMIT 1`,
    [...tagList, p.name, p.legacyNameLike || p.name, p.tag, p.name],
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
    console.log(`已更新 #${existing.id}「${p.name}」tag=${p.tag}`);
    return;
  }

  if (process.env.FORCE_PRODUCT_UPSERT === '1' || process.argv.includes('--create')) {
    const [result] = await pool.query(
      `INSERT INTO products
       (name, tag, gradient, url, description, price_month, price_week, price_day, default_plan, online)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      vals,
    );
    console.log(`已创建 #${result.insertId}「${p.name}」tag=${p.tag}`);
    return;
  }

  console.log(`未找到「${p.name}」，跳过创建。首次请: FORCE_PRODUCT_UPSERT=1 node scripts/upsert-tennis-three-products.js`);
}

async function main() {
  try {
    await pool.query('ALTER TABLE products MODIFY tag VARCHAR(32) NULL');
  } catch {
    /* ignore */
  }
  for (const p of PRODUCTS) {
    await upsertOne(p);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
