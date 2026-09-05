const mysql = require('mysql2/promise');
(async () => {
  const p = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [r] = await p.query(
    'SELECT level, tour, HEX(level) AS h FROM tennis_events WHERE level LIKE ? LIMIT 10',
    ['%GS%'],
  );
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
