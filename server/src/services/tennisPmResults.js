/**
 * Polymarket 一侧到 100¢ 时写入赛果（幂等）。
 */
const pool = require('../db');
const { pickSide } = require('./tennisTrade');

let tableReady = false;
const written = new Set();

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tennis_pm_results (
      event_id BIGINT PRIMARY KEY,
      winner_side VARCHAR(8) NOT NULL,
      winner_name VARCHAR(128) NULL,
      home_name VARCHAR(128) NULL,
      away_name VARCHAR(128) NULL,
      home_price DECIMAL(8,4) NULL,
      away_price DECIMAL(8,4) NULL,
      score_text VARCHAR(128) NULL,
      pick_side VARCHAR(8) NULL,
      pick_name VARCHAR(128) NULL,
      pick_hit TINYINT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'polymarket_100',
      settled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try {
    await pool.query(`
      ALTER TABLE tennis_pm_results
        ADD COLUMN pick_side VARCHAR(8) NULL,
        ADD COLUMN pick_name VARCHAR(128) NULL,
        ADD COLUMN pick_hit TINYINT NULL
    `);
  } catch (e) {
    if (e?.code !== 'ER_DUP_FIELDNAME' && e?.errno !== 1060) throw e;
  }
  tableReady = true;
}

async function upsertPmResult(row) {
  const eventId = Number(row?.eventId);
  const winnerSide = row?.winnerSide === 'away' ? 'away' : (row?.winnerSide === 'home' ? 'home' : '');
  if (!eventId || !winnerSide) return false;
  const pick = row.pickSide === 'home' || row.pickSide === 'away' ? row.pickSide : null;
  const done = `${eventId}:${winnerSide}:${pick || '-'}`;
  if (written.has(`${eventId}:${winnerSide}`) || written.has(done)) return false;
  await ensureTable();
  const pickHit = pick == null ? null : (pick === winnerSide ? 1 : 0);
  await pool.query(
    `INSERT INTO tennis_pm_results (
       event_id, winner_side, winner_name, home_name, away_name,
       home_price, away_price, score_text, pick_side, pick_name, pick_hit, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'polymarket_100')
     ON DUPLICATE KEY UPDATE
       winner_side=VALUES(winner_side),
       winner_name=VALUES(winner_name),
       home_name=VALUES(home_name),
       away_name=VALUES(away_name),
       home_price=VALUES(home_price),
       away_price=VALUES(away_price),
       score_text=VALUES(score_text),
       pick_side=VALUES(pick_side),
       pick_name=VALUES(pick_name),
       pick_hit=VALUES(pick_hit),
       source=VALUES(source)`,
    [
      eventId,
      winnerSide,
      row.winnerName || null,
      row.homeName || null,
      row.awayName || null,
      row.homePrice != null ? Number(row.homePrice) : null,
      row.awayPrice != null ? Number(row.awayPrice) : null,
      row.scoreText || null,
      pick,
      row.pickName || null,
      pickHit,
    ],
  );
  written.add(done);
  if (pick) written.add(`${eventId}:${winnerSide}`);
  return true;
}

/** 不阻塞响应；进程内按 event+winner+推荐 去重 */
function queuePmSettled(matches, rankingsByPlayer) {
  for (const m of matches || []) {
    if (!m?.pmSettled || (m.winner !== 'home' && m.winner !== 'away')) continue;
    const homeName = m.homePlayer?.name || m.home || '';
    const awayName = m.awayPlayer?.name || m.away || '';
    const side = pickSide(m, rankingsByPlayer);
    void upsertPmResult({
      eventId: m.id,
      winnerSide: m.winner,
      winnerName: m.winnerName || (m.winner === 'home' ? homeName : awayName),
      homeName,
      awayName,
      homePrice: m.pmHomePrice,
      awayPrice: m.pmAwayPrice,
      scoreText: m.scoreText || m.score_text || '',
      pickSide: side,
      pickName: side === 'home' ? homeName : (side === 'away' ? awayName : null),
    }).catch((e) => {
      console.warn('[tennis_pm_results]', m.id, e.message || e);
    });
  }
}

module.exports = {
  ensureTable,
  upsertPmResult,
  queuePmSettled,
};
