/**
 * Full replace: copy all tables SRC -> DST (cross-host).
 *   SRC_HOST SRC_PORT SRC_PASSWORD DST_HOST DST_PORT DST_PASSWORD
 *   node scripts/sync-mysql-full.js
 */
const mysql = require('mysql2/promise');

const SRC = {
  host: process.env.SRC_HOST,
  port: Number(process.env.SRC_PORT || 3306),
  user: process.env.SRC_USER || 'root',
  password: process.env.SRC_PASSWORD,
  database: process.env.SRC_DB || 'tennisv2',
  connectTimeout: 30000,
};
const DST = {
  host: process.env.DST_HOST,
  port: Number(process.env.DST_PORT || 3306),
  user: process.env.DST_USER || 'root',
  password: process.env.DST_PASSWORD,
  database: process.env.DST_DB || 'tennisv2',
  connectTimeout: 30000,
  multipleStatements: true,
};

const BATCH = Number(process.env.SYNC_BATCH || 500);

async function copyTable(src, dst, name) {
  await dst.query(`DROP TABLE IF EXISTS \`${name}\``);
  const [createRows] = await src.query(`SHOW CREATE TABLE \`${SRC.database}\`.\`${name}\``);
  await dst.query(createRows[0]['Create Table']);

  const [cntRows] = await src.query(`SELECT COUNT(*) AS n FROM \`${SRC.database}\`.\`${name}\``);
  const total = Number(cntRows[0].n);
  if (!total) return 0;

  let offset = 0;
  while (offset < total) {
    const [rows] = await src.query(
      `SELECT * FROM \`${SRC.database}\`.\`${name}\` LIMIT ? OFFSET ?`,
      [BATCH, offset],
    );
    if (!rows.length) break;
    const cols = Object.keys(rows[0]);
    const colSql = cols.map((c) => `\`${c}\``).join(',');
    const placeholders = cols.map(() => '?').join(',');
    const values = [];
    const tuples = rows.map((row) => {
      cols.forEach((c) => values.push(row[c]));
      return `(${placeholders})`;
    });
    await dst.query(`INSERT INTO \`${name}\` (${colSql}) VALUES ${tuples.join(',')}`, values);
    offset += rows.length;
  }
  return total;
}

async function main() {
  for (const k of ['SRC_HOST', 'SRC_PASSWORD', 'DST_HOST', 'DST_PASSWORD']) {
    if (!process.env[k]) throw new Error(`missing ${k}`);
  }

  const src = await mysql.createConnection({ ...SRC, multipleStatements: true });
  const dst = await mysql.createConnection(DST);

  console.log(
    `Sync ${SRC.host}:${SRC.port}/${SRC.database} -> ${DST.host}:${DST.port}/${DST.database}`,
  );

  await dst.query(
    `CREATE DATABASE IF NOT EXISTS \`${DST.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await dst.query(`USE \`${DST.database}\``);
  await dst.query('SET FOREIGN_KEY_CHECKS=0');

  const [tables] = await src.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`,
    [SRC.database],
  );

  for (const { name } of tables) {
    process.stdout.write(`  ${name} ... `);
    const n = await copyTable(src, dst, name);
    console.log(n, 'rows');
  }

  await dst.query('SET FOREIGN_KEY_CHECKS=1');

  const [u] = await dst.query('SELECT COUNT(*) n, MAX(id) max_id FROM users');
  const [p] = await dst.query('SELECT COUNT(*) n, MAX(id) max_id FROM products');
  const [s] = await dst.query('SELECT COUNT(*) n, MAX(id) max_id FROM scheduler_runs');
  console.log('verify', { users: u[0], products: p[0], scheduler_runs: s[0] });

  await src.end();
  await dst.end();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
