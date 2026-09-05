process.env.ENV_FILE = process.env.ENV_FILE || '.env.test';
const pool = require('../src/db');

(async () => {
  const [rows] = await pool.query(
    `SELECT id, name, tag FROM products
     WHERE LOWER(COALESCE(tag,'')) IN ('nba','dota2','dota','basketball')
        OR name IN ('NBA','DOTA2','DOTA')
     ORDER BY id`,
  );
  console.log(JSON.stringify(rows, null, 2));
  console.log('DB_NAME=', process.env.DB_NAME);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
