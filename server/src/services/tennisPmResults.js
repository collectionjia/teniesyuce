/**
 * Polymarket 一侧到 100¢ 时写入赛果（幂等）；盘后列表从此表读取。
 */
const pool = require('../db');
const { pickSide } = require('./tennisTrade');

let tableReady = false;
const written = new Set();

function shanghaiDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d instanceof Date ? d : new Date(d));
}

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

function rowToMatch(row) {
  const winner = row.winner_side === 'away' ? 'away' : 'home';
  const home = row.home_name || '';
  const away = row.away_name || '';
  const settledAt = row.settled_at ? new Date(row.settled_at) : null;
  const startTs = settledAt && !Number.isNaN(settledAt.getTime())
    ? Math.floor(settledAt.getTime() / 1000)
    : null;
  return {
    id: Number(row.event_id),
    home,
    away,
    homePlayer: { name: home },
    awayPlayer: { name: away },
    status: 'Ended',
    statusType: 'finished',
    scoreText: row.score_text || '',
    winner,
    winnerName: row.winner_name || (winner === 'home' ? home : away),
    pmSettled: true,
    pickSide: row.pick_side || null,
    pickName: row.pick_name || null,
    pickHit: row.pick_hit == null ? null : Number(row.pick_hit),
    pmHomePrice: row.home_price != null ? Number(row.home_price) : null,
    pmAwayPrice: row.away_price != null ? Number(row.away_price) : null,
    startTimestamp: startTs,
    settledAt: settledAt ? settledAt.toISOString() : null,
    source: row.source || 'polymarket_100',
  };
}

function polyFromRow(row) {
  const home = row.home_price != null ? Number(row.home_price) : null;
  const away = row.away_price != null ? Number(row.away_price) : null;
  return {
    home_price: home,
    away_price: away,
    moneyline: {
      outcomes: [row.home_name || 'Home', row.away_name || 'Away'],
      prices: [home, away],
    },
    closed: true,
    source: 'tennis_pm_results',
  };
}

/**
 * @param {{ date?: string|null }} opts date=YYYY-MM-DD（北京日）；空则全部完赛
 */
async function listSettledBundle({ date } = {}) {
  await ensureTable();
  const dateKey = date && /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())
    ? String(date).trim()
    : null;
  let rows;
  if (dateKey) {
    const [r] = await pool.query(
      `SELECT *
       FROM tennis_pm_results
       WHERE DATE(CONVERT_TZ(settled_at, @@session.time_zone, '+08:00')) = ?
       ORDER BY settled_at DESC`,
      [dateKey],
    );
    rows = r;
  } else {
    const [r] = await pool.query(
      `SELECT * FROM tennis_pm_results ORDER BY settled_at DESC LIMIT 500`,
    );
    rows = r;
  }
  const matches = (rows || []).map(rowToMatch);
  const polymarketByEvent = {};
  for (const row of rows || []) {
    polymarketByEvent[String(row.event_id)] = polyFromRow(row);
  }
  const [dateRows] = await pool.query(
    `SELECT DATE_FORMAT(CONVERT_TZ(settled_at, @@session.time_zone, '+08:00'), '%Y-%m-%d') AS day,
            COUNT(*) AS n
     FROM tennis_pm_results
     GROUP BY day
     ORDER BY day DESC
     LIMIT 60`,
  );
  const availableDates = (dateRows || []).map((d) => ({
    date: d.day,
    count: Number(d.n) || 0,
  }));
  const now = Math.floor(Date.now() / 1000);
  return {
    ok: true,
    empty: matches.length === 0,
    sport: 'tennis',
    source: 'mysql-tennis_pm_results',
    dataSource: 'tennis_pm_results',
    date: dateKey || 'all',
    availableDates,
    scheduled: { tournaments: [], tournamentCount: 0, eventCount: 0 },
    live: {
      matches,
      tournaments: [],
      tournamentCount: 0,
      eventCount: matches.length,
    },
    rankingsByPlayer: {},
    oddsByEvent: {},
    polymarketByEvent,
    events: matches.length,
    serverTime: now,
    fetched_at: new Date().toISOString(),
    message: dateKey
      ? `盘后 · ${dateKey} · ${matches.length} 场`
      : `盘后 · 全部 · ${matches.length} 场`,
    update: { message: 'tennis_pm_results' },
  };
}

module.exports = {
  ensureTable,
  upsertPmResult,
  queuePmSettled,
  listSettledBundle,
  shanghaiDateKey,
};
