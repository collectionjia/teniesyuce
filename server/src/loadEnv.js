const fs = require('fs');
const path = require('path');

/** server 根目录（含 .env） */
const SERVER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV = path.join(SERVER_ROOT, '.env');

/** 解析 ENV_FILE，避免 ../../server/.env 在 server 目录下指到错误路径 */
function resolveEnvPath() {
  const raw = (process.env.ENV_FILE || '').trim();
  if (!raw) return DEFAULT_ENV;

  const candidates = [
    path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw),
    path.resolve(SERVER_ROOT, raw),
    DEFAULT_ENV,
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_ENV;
}

function loadEnv() {
  require('dotenv').config({ path: resolveEnvPath() });
}

module.exports = { loadEnv, resolveEnvPath, SERVER_ROOT };
