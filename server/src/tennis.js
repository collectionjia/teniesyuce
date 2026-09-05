const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToEvent(row) {
  const homeId = row.home_player_id;
  const awayId = row.away_player_id;
  return {
    id: Number(row.id),
    level: row.level,
    tour: row.tour,
    gender: row.gender,
    tennisPoints: null,
    tournament: row.tournament_name,
    tournamentShort: row.tournament_short,
    status: row.status,
    statusType: row.status === 'Ended' ? 'finished' : row.status === 'Not started' ? 'notstarted' : 'inprogress',
    home: row.home_name,
    away: row.away_name,
    homePlayer: {
      id: homeId,
      name: row.home_name,
      ranking: num(row.home_rank),
      gender: row.gender,
      age: num(row.home_age),
    },
    awayPlayer: {
      id: awayId,
      name: row.away_name,
      ranking: num(row.away_rank),
      gender: row.gender,
      age: num(row.away_age),
    },
    home_score: num(row.home_score),
    away_score: num(row.away_score),
    startTimestamp: Number(row.start_timestamp),
    roundLabel: row.round_label,
    groundLabel: row.ground_label,
    slug: row.slug,
    customId: row.custom_id,
  };
}

function buildBundle(rows) {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const rankingsByPlayer = {};
  const oddsByEvent = {};
  const eloByEvent = {};
  const polymarketByEvent = {};
  const tournamentsMap = new Map();
  const liveMatches = [];

  for (const row of rows) {
    const ev = rowToEvent(row);
    const isLive =
      row.status !== 'Not started' &&
      row.status !== 'Ended' &&
      String(row.status).toLowerCase() !== 'walkover';

    rankingsByPlayer[String(row.home_player_id)] = {
      current: num(row.home_rank),
      previous: num(row.home_rank_prev),
      best: num(row.home_rank_best),
      live: num(row.home_rank_live),
      utr: num(row.home_utr),
    };
    rankingsByPlayer[String(row.away_player_id)] = {
      current: num(row.away_rank),
      previous: num(row.away_rank_prev),
      best: num(row.away_rank_best),
      live: num(row.away_rank_live),
      utr: num(row.away_utr),
    };

    if (row.home_odds != null || row.away_odds != null) {
      oddsByEvent[String(row.id)] = {
        eventId: Number(row.id),
        source: row.odds_source || 'mysql',
        full_time: {
          home: { decimal: num(row.home_odds), change: 0 },
          away: { decimal: num(row.away_odds), change: 0 },
          source: row.odds_source || 'mysql',
        },
      };
    }

    if (row.home_elo_win_pct != null || row.away_elo_win_pct != null) {
      const homeShort = String(row.home_name).trim().split(/\s+/).pop();
      const awayShort = String(row.away_name).trim().split(/\s+/).pop();
      const homeEdge = num(row.home_elo_edge_pct);
      const awayEdge = num(row.away_elo_edge_pct);
      const bestSide =
        homeEdge != null && awayEdge != null
          ? homeEdge >= awayEdge
            ? { short: homeShort, win_pct: num(row.home_elo_win_pct), edge_pct: homeEdge }
            : { short: awayShort, win_pct: num(row.away_elo_win_pct), edge_pct: awayEdge }
          : { short: homeShort, win_pct: num(row.home_elo_win_pct), edge_pct: homeEdge };
      eloByEvent[String(row.id)] = {
        ok: true,
        surface: row.elo_surface || 'elo',
        ratingSource: row.elo_surface || 'elo',
        home: {
          short: homeShort,
          win_pct: num(row.home_elo_win_pct),
          edge_pct: homeEdge,
          age: num(row.home_age),
        },
        away: {
          short: awayShort,
          win_pct: num(row.away_elo_win_pct),
          edge_pct: awayEdge,
          age: num(row.away_age),
        },
        best: bestSide,
      };
    }

    if (row.polymarket_url) {
      polymarketByEvent[String(row.id)] = {
        title: row.polymarket_title || `${row.home_name} vs ${row.away_name}`,
        url: row.polymarket_url,
        moneyline: {
          outcomes: [row.home_name, row.away_name],
          prices: [num(row.poly_home_price) ?? 0.5, num(row.poly_away_price) ?? 0.5],
        },
      };
    }

    const key = `${row.tour}|${row.level}|${row.tournament_short}`;
    if (!tournamentsMap.has(key)) {
      tournamentsMap.set(key, {
        level: row.level,
        tour: row.tour,
        name: row.tournament_name,
        events: [],
      });
    }
    tournamentsMap.get(key).events.push(ev);
    if (isLive) liveMatches.push(ev);
  }

  const tournaments = [...tournamentsMap.values()];
  const eventCount = tournaments.reduce((n, t) => n + t.events.length, 0);

  return {
    fetched_at: new Date().toISOString(),
    sport: 'tennis',
    filter: ['ATP1000', 'ATP500', 'WTA1000', 'WTA500'],
    date,
    source: 'mysql',
    live: { count: liveMatches.length, matches: liveMatches },
    scheduled: {
      tournamentCount: tournaments.length,
      eventCount,
      tournaments,
      eventsFetchedTournaments: tournaments.length,
    },
    rankingsByPlayer,
    oddsByEvent,
    eloByEvent,
    polymarketByEvent,
    theOddsApiByEvent: {},
    birthYearByPlayer: {},
    topRankMax: 20,
    dataFilter: 'mysql',
    excludeEnded: false,
    update: {
      ok: true,
      fresh: true,
      at: new Date().toISOString(),
      message: '数据来自 MySQL（tennisv2.tennis_matches）',
      events: eventCount,
      source: 'mysql',
    },
  };
}

router.get('/today', auth(), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM tennis_matches
       WHERE match_date >= CURDATE() - INTERVAL 1 DAY
       ORDER BY start_timestamp ASC, id ASC`
    );
    res.json(buildBundle(rows));
  } catch (e) {
    console.error('[tennis/today]', e);
    if (String(e.message || '').includes("doesn't exist")) {
      return res.status(503).json({
        ok: false,
        error: '网球表未初始化，请先运行 node scripts/seed-tennis-mysql.js',
      });
    }
    res.status(500).json({ ok: false, error: '读取网球数据失败' });
  }
});

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tennis-mysql', db: process.env.DB_NAME || 'tennisv2' });
});

module.exports = router;
