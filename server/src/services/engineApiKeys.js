/**
 * 引擎对外 API Key：有密钥即可调 /api/engine/*，不看角色
 */
const crypto = require('crypto');
const pool = require('../db');

let ready = false;

async function ensureTable() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engine_api_keys (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      key_prefix VARCHAR(16) NOT NULL,
      key_hash CHAR(64) NOT NULL,
      owner_user_id INT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      last_used_at DATETIME NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      UNIQUE KEY uk_engine_key_hash (key_hash),
      INDEX idx_engine_keys_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ready = true;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function generateRawKey() {
  return `eng_${crypto.randomBytes(24).toString('base64url')}`;
}

async function createKey({ name, ownerUserId = null, createdBy = null } = {}) {
  await ensureTable();
  const raw = generateRawKey();
  const prefix = raw.slice(0, 12);
  const [result] = await pool.query(
    `INSERT INTO engine_api_keys (name, key_prefix, key_hash, owner_user_id, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [String(name || 'engine-key').slice(0, 128), prefix, hashKey(raw), ownerUserId, createdBy]
  );
  return {
    id: result.insertId,
    name: String(name || 'engine-key').slice(0, 128),
    keyPrefix: prefix,
    apiKey: raw,
    ownerUserId,
  };
}

async function listKeys() {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, name, key_prefix AS keyPrefix, owner_user_id AS ownerUserId,
            enabled, last_used_at AS lastUsedAt, created_by AS createdBy,
            created_at AS createdAt, revoked_at AS revokedAt
     FROM engine_api_keys
     ORDER BY id DESC`
  );
  return rows;
}

async function revokeKey(id) {
  await ensureTable();
  await pool.query(
    `UPDATE engine_api_keys SET enabled=0, revoked_at=NOW() WHERE id=?`,
    [id]
  );
}

async function deleteKey(id) {
  await ensureTable();
  const [result] = await pool.query(`DELETE FROM engine_api_keys WHERE id=?`, [id]);
  return result.affectedRows > 0;
}

async function setEnabled(id, enabled) {
  await ensureTable();
  await pool.query(
    `UPDATE engine_api_keys SET enabled=?, revoked_at=IF(?, NULL, COALESCE(revoked_at, NOW())) WHERE id=?`,
    [enabled ? 1 : 0, enabled ? 1 : 0, id]
  );
}

/**
 * @returns {Promise<null|{ id:number, name:string, ownerUserId:number|null }>}
 */
async function verifyRawKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const token = raw.trim();
  if (!token) return null;
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, name, owner_user_id AS ownerUserId
     FROM engine_api_keys
     WHERE key_hash=? AND enabled=1 AND revoked_at IS NULL
     LIMIT 1`,
    [hashKey(token)]
  );
  const row = rows[0];
  if (!row) return null;
  pool.query(`UPDATE engine_api_keys SET last_used_at=NOW() WHERE id=?`, [row.id]).catch(() => {});
  return row;
}

module.exports = {
  ensureTable,
  createKey,
  listKeys,
  revokeKey,
  deleteKey,
  setEnabled,
  verifyRawKey,
};
