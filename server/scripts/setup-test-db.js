/**
 * Create tennisv2_test from tennisv2 (schema + seed data).
 * Usage: node scripts/setup-test-db.js
 * Reads DB_* from env / .env / .env.test (source host); writes into DB_NAME_TEST or tennisv2_test.
 */
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env') });

const mysql = require('mysql2/promise');

const SOURCE_DB = process.env.DB_NAME_SOURCE || 'tennisv2';
const TEST_DB = process.env.DB_NAME_TEST || 'tennisv2_test';

const CORE_SEED_TABLES = ['products', 'app_settings'];

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
    timezone: '+08:00',
  });

  console.log(`Source: ${SOURCE_DB} → Test: ${TEST_DB} @ ${process.env.DB_HOST}:${process.env.DB_PORT}`);

  await pool.query(
    `CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );

  const [tables] = await pool.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`,
    [SOURCE_DB],
  );

  for (const { name } of tables) {
    console.log(`  clone schema: ${name}`);
    await pool.query(`DROP TABLE IF EXISTS \`${TEST_DB}\`.\`${name}\``);
    await pool.query(`CREATE TABLE \`${TEST_DB}\`.\`${name}\` LIKE \`${SOURCE_DB}\`.\`${name}\``);
  }

  for (const name of CORE_SEED_TABLES) {
    if (!tables.some((t) => t.name === name)) continue;
    console.log(`  seed data: ${name}`);
    await pool.query(`INSERT INTO \`${TEST_DB}\`.\`${name}\` SELECT * FROM \`${SOURCE_DB}\`.\`${name}\``);
  }

  // Seed a known test admin (idempotent)
  const account = process.env.TEST_ADMIN_ACCOUNT || 'admin@test.local';
  const password = process.env.TEST_ADMIN_PASSWORD || 'test123456';
  const hash = await bcrypt.hash(password, 10);
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM \`${TEST_DB}\`.users WHERE account=?`,
    [account],
  );
  if (!n) {
    await pool.query(
      `INSERT INTO \`${TEST_DB}\`.users
        (account, password_hash, name, role, balance, invite_code, agent_status, commission_rate)
       VALUES (?,?,?,'admin',0,NULL,'approved',0)`,
      [account, hash, '测试管理员'],
    );
    console.log(`  admin created: ${account} / ${password}`);
  } else {
    console.log(`  admin exists: ${account}`);
  }

  const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt FROM \`${TEST_DB}\`.products`);
  console.log(`Done. ${TEST_DB} products=${cnt}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
