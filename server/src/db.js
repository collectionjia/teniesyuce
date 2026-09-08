const path = require('path');
const mysql = require('mysql2/promise');

// ENV_FILE=.env.test 时走测试库；默认仍加载 server/.env
require('dotenv').config({
  path: process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.resolve(__dirname, '..', '.env'),
});

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+08:00',
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  // 远程库偶发断线时，避免复用已死连接
  maxIdle: 5,
  idleTimeout: 60000,
});

pool.on('connection', () => {
  /* pool ready */
});

module.exports = pool;
