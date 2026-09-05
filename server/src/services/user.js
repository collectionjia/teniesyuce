const pool = require('../db');

let columnsReady = false;

async function ensureUserColumns() {
  if (columnsReady) return;
  const migrations = [
    'ALTER TABLE users ADD COLUMN tennis_filter_enabled TINYINT(1) NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN btc_sim_enabled TINYINT(1) NOT NULL DEFAULT 0',
  ];
  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
  }
  columnsReady = true;
}

function mapTennisFilterEnabled(row) {
  return !!row.tennis_filter_enabled;
}

function mapBtcSimEnabled(row) {
  return !!row.btc_sim_enabled;
}

module.exports = {
  ensureUserColumns,
  mapTennisFilterEnabled,
  mapBtcSimEnabled,
};
