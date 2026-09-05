const mysql = require("mysql2/promise");

(async () => {
  const p = await mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [cols] = await p.query("SHOW COLUMNS FROM products");
  console.log(
    "cols:",
    cols.map((c) => c.Field).join(","),
  );
  const [rows] = await p.query(
    `SELECT * FROM products
     WHERE LOWER(COALESCE(tag,'')) = 'tennis'
        OR name LIKE '%网球%'
        OR LOWER(name) LIKE '%tennis%'
     LIMIT 20`,
  );
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
