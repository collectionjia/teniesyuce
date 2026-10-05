/**
 * 生产产品种子：不含「比赛中」「比赛结束」拆分产品。
 *   cd server && ENV_FILE=.env.prod node scripts/seed-products.js
 */
require('dotenv').config({
  path: process.env.ENV_FILE
    ? require('path').resolve(process.cwd(), process.env.ENV_FILE)
    : require('path').join(__dirname, '..', '.env'),
  override: true,
});

const pool = require('../src/db');

const ONLINE = [
  {
    name: '网球赛事推荐',
    tag: 'tennis-prematch',
    gradient: 'linear-gradient(135deg,#0ea5e9,#2563eb)',
    url: '#',
    description: '未开赛与进行中同列表推荐；现排≤100，可手动或引擎投注。',
    price_month: 2,
    price_week: 1,
    price_day: 0.5,
    default_plan: 'month',
    legacyNames: ['未开赛的网球比赛', '盘前网球'],
  },
  {
    name: 'dota2赛事推荐',
    tag: 'dota2',
    gradient: 'linear-gradient(135deg,#b91c1c,#ea580c)',
    url: '#',
    description: 'Polymarket 未开赛对阵列表，订阅后可下单。',
    price_month: 2,
    price_week: 1,
    price_day: 0.5,
    default_plan: 'month',
    legacyNames: ['DOTA', 'Dota2'],
  },
  {
    name: 'nfl赛事推荐',
    tag: 'nfl',
    gradient: 'linear-gradient(135deg,#1d4ed8,#0f766e)',
    url: '#',
    description: 'Polymarket 未开赛对阵列表，订阅后可下单。',
    price_month: 2,
    price_week: 1,
    price_day: 0.5,
    default_plan: 'month',
  },
  {
    name: 'nba赛事推荐',
    tag: 'nba',
    gradient: 'linear-gradient(135deg,#c45c26,#ea580c)',
    url: '#',
    description: 'Polymarket NBA 未开赛对阵，订阅后可下单。',
    price_month: 2,
    price_week: 1,
    price_day: 0.5,
    default_plan: 'month',
    legacyNames: ['篮球预测', '篮球'],
  },
];

const OFFLINE_TAGS = [
  'tennis', 'tennis-inplay', 'tennis-settled', 'tennis-live', 'crypto',
];

async function findProduct(p) {
  const names = [p.name, ...(p.legacyNames || [])];
  const [rows] = await pool.query(
    `SELECT id, name, tag FROM products
     WHERE LOWER(COALESCE(tag,'')) = ?
        OR name IN (?)
     ORDER BY CASE WHEN LOWER(COALESCE(tag,'')) = ? THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [p.tag, names, p.tag],
  );
  return rows[0];
}

async function upsertOnline(p) {
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
    1,
  ];
  const existing = await findProduct(p);
  if (existing) {
    await pool.query(
      `UPDATE products SET name=?, tag=?, gradient=?, url=?, description=?,
       price_month=?, price_week=?, price_day=?, default_plan=?, online=? WHERE id=?`,
      [...vals, existing.id],
    );
    console.log(`更新 #${existing.id} ${p.name} (${p.tag})`);
    return;
  }
  const [r] = await pool.query(
    `INSERT INTO products
     (name, tag, gradient, url, description, price_month, price_week, price_day, default_plan, online)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    vals,
  );
  console.log(`创建 #${r.insertId} ${p.name} (${p.tag})`);
}

async function offlineProducts() {
  const [r1] = await pool.query(
    `UPDATE products SET online=0
     WHERE LOWER(COALESCE(tag,'')) IN (?)
        OR name LIKE '%比赛中的网球%'
        OR name LIKE '%比赛结束%网球%'
        OR name = '网球'
        OR name LIKE '%BTC%'
        OR name IN ('盘中网球', '盘后网球')`,
    [OFFLINE_TAGS],
  );
  console.log(`下架网球/BTC 等: ${r1.affectedRows} 行`);
}

async function main() {
  await offlineProducts();
  for (const p of ONLINE) await upsertOnline(p);
  const [rows] = await pool.query(
    `SELECT id, name, tag, online FROM products ORDER BY online DESC, id`,
  );
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
