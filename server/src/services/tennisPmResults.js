/**
 * Polymarket 一侧到 100¢ 时写入赛果（幂等）；盘后列表从此表读取。
 */
const pool = require('../db');
const { pickSide } = require('./tennisTrade');
const tennisInplayCache = require('./tennisInplayCache');
const tennisPrematchCache = require('./tennisPrematchCache');
const tennisCache = require('./tennisCache');

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

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function playerRankFields(player, rankingsByPlayer) {
  const id = player?.id ?? player?.teamId;
  const map = rankingsByPlayer || {};
  const fromMap = id != null ? map[String(id)] || map[id] : null;
  return {
    current: numOrNull(fromMap?.current ?? player?.ranking ?? player?.currentRank ?? player?.rank),
    best: numOrNull(fromMap?.best ?? player?.bestRank ?? player?.best),
    previous: numOrNull(fromMap?.previous ?? player?.previousRank),
    live: numOrNull(fromMap?.live ?? player?.liveRank),
    id: id != null ? id : null,
  };
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
      home_rank INT NULL,
      away_rank INT NULL,
      home_best_rank INT NULL,
      away_best_rank INT NULL,
      home_player_id BIGINT NULL,
      away_player_id BIGINT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'polymarket_100',
      settled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  for (const col of [
    'pick_side VARCHAR(8) NULL',
    'pick_name VARCHAR(128) NULL',
    'pick_hit TINYINT NULL',
    'home_rank INT NULL',
    'away_rank INT NULL',
    'home_best_rank INT NULL',
    'away_best_rank INT NULL',
    'home_player_id BIGINT NULL',
    'away_player_id BIGINT NULL',
  ]) {
    try {
      await pool.query(`ALTER TABLE tennis_pm_results ADD COLUMN ${col}`);
    } catch (e) {
      if (e?.code !== 'ER_DUP_FIELDNAME' && e?.errno !== 1060) throw e;
    }
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
       home_price, away_price, score_text, pick_side, pick_name, pick_hit,
       home_rank, away_rank, home_best_rank, away_best_rank,
       home_player_id, away_player_id, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'polymarket_100')
     ON DUPLICATE KEY UPDATE
       winner_side=VALUES(winner_side),
       winner_name=VALUES(winner_name),
       home_name=VALUES(home_name),
       away_name=VALUES(away_name),
       home_price=VALUES(home_price),
       away_price=VALUES(away_price),
       score_text=COALESCE(NULLIF(VALUES(score_text), ''), score_text),
       pick_side=VALUES(pick_side),
       pick_name=VALUES(pick_name),
       pick_hit=VALUES(pick_hit),
       home_rank=COALESCE(VALUES(home_rank), home_rank),
       away_rank=COALESCE(VALUES(away_rank), away_rank),
       home_best_rank=COALESCE(VALUES(home_best_rank), home_best_rank),
       away_best_rank=COALESCE(VALUES(away_best_rank), away_best_rank),
       home_player_id=COALESCE(VALUES(home_player_id), home_player_id),
       away_player_id=COALESCE(VALUES(away_player_id), away_player_id),
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
      row.homeRank ?? null,
      row.awayRank ?? null,
      row.homeBestRank ?? null,
      row.awayBestRank ?? null,
      row.homePlayerId ?? null,
      row.awayPlayerId ?? null,
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
    const homeR = playerRankFields(m.homePlayer || { name: homeName }, rankingsByPlayer);
    const awayR = playerRankFields(m.awayPlayer || { name: awayName }, rankingsByPlayer);
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
      homeRank: homeR.current,
      awayRank: awayR.current,
      homeBestRank: homeR.best,
      awayBestRank: awayR.best,
      homePlayerId: homeR.id,
      awayPlayerId: awayR.id,
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
  const homeRank = numOrNull(row.home_rank);
  const awayRank = numOrNull(row.away_rank);
  const homeBest = numOrNull(row.home_best_rank);
  const awayBest = numOrNull(row.away_best_rank);
  const homeId = row.home_player_id != null ? Number(row.home_player_id) : null;
  const awayId = row.away_player_id != null ? Number(row.away_player_id) : null;
  return {
    id: Number(row.event_id),
    home,
    away,
    homePlayer: {
      id: homeId,
      name: home,
      ranking: homeRank,
      currentRank: homeRank,
      bestRank: homeBest,
    },
    awayPlayer: {
      id: awayId,
      name: away,
      ranking: awayRank,
      currentRank: awayRank,
      bestRank: awayBest,
    },
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
    homeRank,
    awayRank,
    rankGap: homeRank != null && awayRank != null ? Math.abs(homeRank - awayRank) : null,
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

function allMatchesFromBundle(bundle) {
  if (!bundle) return [];
  const live = bundle.live?.matches || [];
  const fromSched = (bundle.scheduled?.tournaments || []).flatMap((t) =>
    (t.events || []).map((e) => ({ ...e, tournament: e.tournament || t.name })),
  );
  return [...live, ...fromSched];
}

function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function buildNameRankIndex(top100, rankingsByPlayer) {
  const byName = new Map();
  const put = (name, row) => {
    const full = normName(name);
    if (!full || !row) return;
    if (!byName.has(full)) byName.set(full, row);
    const parts = String(name).trim().split(/\s+/);
    if (parts.length > 1) {
      const last = normName(parts[parts.length - 1]);
      if (last && last.length >= 3 && !byName.has(last)) byName.set(last, row);
    }
  };
  for (const tour of ['atp', 'wta']) {
    for (const p of top100?.[tour] || []) {
      if (!p?.name) continue;
      const id = p.id;
      const fromMap = id != null ? (rankingsByPlayer[String(id)] || rankingsByPlayer[id]) : null;
      put(p.name, {
        id: id != null ? id : null,
        current: numOrNull(fromMap?.current ?? p.rank),
        previous: numOrNull(fromMap?.previous ?? p.previousRank ?? p.previous),
        best: numOrNull(fromMap?.best ?? p.bestRank ?? p.best),
        live: numOrNull(fromMap?.live ?? p.liveRank),
        name: p.name,
      });
    }
  }
  return byName;
}

function lookupRankByName(name, byName) {
  if (!byName || !name) return null;
  const full = normName(name);
  if (full && byName.has(full)) return byName.get(full);
  const parts = String(name).trim().split(/\s+/);
  if (parts.length) {
    const last = normName(parts[parts.length - 1]);
    if (last && byName.has(last)) return byName.get(last);
  }
  return null;
}

function mergePlayerRank(player, baseRank, byName, rankingsByPlayer) {
  const fromId = playerRankFields(player, rankingsByPlayer);
  const fromName = lookupRankByName(player?.name, byName);
  const current = numOrNull(baseRank ?? fromId.current ?? fromName?.current ?? player?.ranking);
  const best = numOrNull(player?.bestRank ?? fromId.best ?? fromName?.best);
  const previous = numOrNull(player?.previousRank ?? fromId.previous ?? fromName?.previous);
  const live = numOrNull(player?.liveRank ?? fromId.live ?? fromName?.live);
  const id = player?.id ?? fromId.id ?? fromName?.id ?? null;
  return {
    ...player,
    id,
    ranking: current,
    currentRank: current,
    bestRank: best,
    previousRank: previous,
    liveRank: live,
  };
}

function enrichMatchFromLive(base, rich, rankingsByPlayer, byName) {
  const srcHome = rich?.homePlayer || { name: rich?.home || base.home, ...(base.homePlayer || {}) };
  const srcAway = rich?.awayPlayer || { name: rich?.away || base.away, ...(base.awayPlayer || {}) };
  const homePlayer = mergePlayerRank(
    { ...srcHome, name: srcHome.name || base.home },
    base.homeRank,
    byName,
    rankingsByPlayer,
  );
  const awayPlayer = mergePlayerRank(
    { ...srcAway, name: srcAway.name || base.away },
    base.awayRank,
    byName,
    rankingsByPlayer,
  );
  const homeRank = homePlayer.currentRank;
  const awayRank = awayPlayer.currentRank;
  return {
    ...base,
    home: base.home || rich?.home,
    away: base.away || rich?.away,
    homePlayer,
    awayPlayer,
    scoreText: base.scoreText || rich?.scoreText || rich?.score_text || '',
    tournament: rich?.tournament || rich?.tournamentShort || base.tournament,
    tournamentShort: rich?.tournamentShort || base.tournamentShort,
    roundLabel: rich?.roundLabel || base.roundLabel,
    groundLabel: rich?.groundLabel || base.groundLabel,
    gender: rich?.gender || base.gender,
    slug: rich?.slug || base.slug,
    customId: rich?.customId || base.customId,
    url: rich?.url || base.url,
    period1: rich?.period1 ?? base.period1,
    period2: rich?.period2 ?? base.period2,
    period3: rich?.period3 ?? base.period3,
    period4: rich?.period4 ?? base.period4,
    period5: rich?.period5 ?? base.period5,
    home_score: rich?.home_score ?? rich?.homeScore ?? base.home_score,
    away_score: rich?.away_score ?? rich?.awayScore ?? base.away_score,
    homeRank,
    awayRank,
    rankGap: homeRank != null && awayRank != null ? Math.abs(homeRank - awayRank) : null,
    startTimestamp: rich?.startTimestamp || base.startTimestamp,
  };
}

async function loadEnrichmentCaches() {
  const [inplay, prematch, full] = await Promise.all([
    tennisInplayCache.getBundle().catch(() => null),
    tennisPrematchCache.getBundle().catch(() => null),
    tennisCache.getBundle().catch(() => null),
  ]);
  const byId = new Map();
  const rankingsByPlayer = {};
  for (const b of [full, inplay, prematch]) {
    if (!b) continue;
    Object.assign(rankingsByPlayer, b.rankingsByPlayer || {});
    for (const m of allMatchesFromBundle(b)) {
      if (m?.id == null) continue;
      const id = String(m.id);
      if (!byId.has(id)) byId.set(id, m);
    }
  }
  const top100 = full?.top100 || full?.rankingsBoard || {};
  const byName = buildNameRankIndex(top100, rankingsByPlayer);
  return { byId, rankingsByPlayer, byName };
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
  const { byId, rankingsByPlayer, byName } = await loadEnrichmentCaches();
  const matches = (rows || []).map((row) => {
    const base = rowToMatch(row);
    return enrichMatchFromLive(base, byId.get(String(base.id)), rankingsByPlayer, byName);
  });
  const polymarketByEvent = {};
  for (const row of rows || []) {
    polymarketByEvent[String(row.event_id)] = polyFromRow(row);
  }
  for (const m of matches) {
    const hid = m.homePlayer?.id;
    const aid = m.awayPlayer?.id;
    if (hid != null && m.homeRank != null) {
      rankingsByPlayer[String(hid)] = {
        ...(rankingsByPlayer[String(hid)] || {}),
        current: m.homeRank,
        best: m.homePlayer?.bestRank ?? rankingsByPlayer[String(hid)]?.best,
      };
    }
    if (aid != null && m.awayRank != null) {
      rankingsByPlayer[String(aid)] = {
        ...(rankingsByPlayer[String(aid)] || {}),
        current: m.awayRank,
        best: m.awayPlayer?.bestRank ?? rankingsByPlayer[String(aid)]?.best,
      };
    }
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
    rankingsByPlayer,
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
