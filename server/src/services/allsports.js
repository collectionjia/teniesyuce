const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const BASE = (
  process.env.ALLSPORTS_API_BASE || 'https://allsportsapi2.p.rapidapi.com'
).replace(/\/$/, '');
const HOST = process.env.ALLSPORTS_RAPIDAPI_HOST || 'allsportsapi2.p.rapidapi.com';
const CACHE_MS = Number(process.env.ALLSPORTS_CACHE_MS || 90_000);
const RANK_CACHE_MS = Number(process.env.ALLSPORTS_RANK_CACHE_MS || 15 * 60_000);
const TOUR_POINTS = new Set(
  String(process.env.ALLSPORTS_TOUR_POINTS || '250,500,1000,2000')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter(Number.isFinite),
);

let scheduleCache = { at: 0, bundle: null };
let rankCache = { at: 0, map: null };
let inflight = null;

function apiKey() {
  return (
    process.env.RAPIDAPI_KEY ||
    process.env.ALLSPORTS_RAPIDAPI_KEY ||
    process.env.X_RAPIDAPI_KEY ||
    ''
  ).trim();
}

function isConfigured() {
  return !!apiKey();
}

function todayParts(timeZone = process.env.ALLSPORTS_TZ || 'Asia/Shanghai') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = fmt.format(new Date()).split('-').map(Number);
  return {
    year,
    month,
    day,
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

const REQUEST_GAP_MS = Number(process.env.ALLSPORTS_REQUEST_GAP_MS || 400);
let requestChain = Promise.resolve();

function enqueueRequest(fn) {
  const run = requestChain.then(fn, fn);
  requestChain = run.then(() => new Promise((r) => setTimeout(r, REQUEST_GAP_MS))).catch(() => {});
  return run;
}

async function rapidGet(path) {
  return enqueueRequest(() => rapidGetNow(path));
}

async function rapidGetNow(path) {
  const key = apiKey();
  if (!key) throw new Error('未配置 RAPIDAPI_KEY');
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': HOST,
    },
  });
  if (res.status === 204) return {};
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`AllSports 非 JSON：${path} HTTP ${res.status}`);
    }
  }
  if (!res.ok) {
    const msg = body.message || body.error || text.slice(0, 180) || res.statusText;
    throw new Error(`AllSports ${res.status} ${path}: ${msg}`);
  }
  return body;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function eventTennisPoints(ev) {
  const tournament = ev?.tournament || {};
  const unique = tournament.uniqueTournament || {};
  return num(unique.tennisPoints ?? tournament.tennisPoints);
}

function eventTourSlug(ev) {
  const tournament = ev?.tournament || {};
  const unique = tournament.uniqueTournament || {};
  const category = unique.category || tournament.category || {};
  return String(category.slug || '').toLowerCase();
}

function isAtpWtaCategory(cat) {
  const slug = String(cat?.slug || '').toLowerCase();
  const name = String(cat?.name || '');
  if (slug === 'atp' || slug === 'wta') return true;
  if (/challenger|itf|utr|exhibition/i.test(`${slug} ${name}`)) return false;
  return /\bATP\b|\bWTA\b/.test(name);
}

function tourLevelLabel(points, tourSlug) {
  const tour = String(tourSlug || 'atp').toUpperCase();
  if (points === 1000) return `${tour} 1000`;
  if (points === 500) return `${tour} 500`;
  if (points === 250) return `${tour} 250`;
  if (points === 2000) return `${tour} GS`;
  return tour;
}

function roundLabel(roundInfo) {
  if (!roundInfo) return null;
  const name = roundInfo.name || '';
  const mapping = {
    'Round of 128': '128 强',
    'Round of 64': '64 强',
    'Round of 32': '32 强',
    'Round of 16': '16 强',
    Quarterfinals: '四分之一决赛',
    'Quarter-finals': '四分之一决赛',
    Semifinals: '半决赛',
    'Semi-finals': '半决赛',
    Final: '决赛',
  };
  return mapping[name] || name || null;
}

function groundLabel(ground) {
  if (!ground) return null;
  const g = String(ground).toLowerCase();
  if (g.includes('hard') && g.includes('indoor')) return '室内硬地';
  if (g.includes('hard')) return '室外硬地';
  if (g.includes('clay')) return '红土';
  if (g.includes('grass')) return '草地';
  return ground;
}

function slimSubPlayer(team) {
  if (!team) return null;
  return {
    id: team.id,
    name: team.name,
    ranking: num(team.ranking),
    gender: team.gender,
    birthYear: num(
      team.playerTeamInfo?.birthYear
        ?? (team.dateOfBirthTimestamp
          ? new Date(Number(team.dateOfBirthTimestamp) * 1000).getUTCFullYear()
          : null),
    ),
  };
}

function slimPlayer(team) {
  team = team || {};
  const subs = asArray(team.subTeams).map(slimSubPlayer).filter(Boolean);
  let ranking = num(team.ranking);
  if (ranking == null && subs.length) {
    const ranks = subs.map((s) => s.ranking).filter((r) => r != null);
    if (ranks.length) ranking = Math.min(...ranks);
  }
  const birthYear = birthYearOf(team);
  const out = {
    id: team.id,
    name: team.name,
    shortName: team.shortName,
    ranking,
    country: team.country?.alpha2 || team.country?.alpha3 || null,
    gender: team.gender,
    age: ageFromBirthYear(birthYear),
  };
  if (birthYear) out.birthYear = birthYear;
  if (subs.length) out.subTeams = subs;
  return out;
}

function birthYearOf(team) {
  if (!team) return null;
  const direct = num(team.playerTeamInfo?.birthYear ?? team.birthYear);
  if (direct) return direct;
  const ts = num(team.dateOfBirthTimestamp ?? team.playerTeamInfo?.dateOfBirthTimestamp);
  if (!ts) return null;
  return new Date(ts * 1000).getUTCFullYear();
}

function ageFromBirthYear(year) {
  if (!year) return null;
  const age = new Date().getUTCFullYear() - Number(year);
  return age > 0 && age < 80 ? age : null;
}

function shortNameOf(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : '—';
}

function fractionalToDecimal(frac) {
  if (frac == null || frac === '') return null;
  if (typeof frac === 'number') return Number.isFinite(frac) && frac > 1 ? frac : null;
  const text = String(frac).trim();
  if (!text.includes('/')) {
    const n = Number(text);
    return Number.isFinite(n) && n > 1 ? n : null;
  }
  const [a, b] = text.split('/').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !b) return null;
  return Math.round((1 + a / b) * 100) / 100;
}

function choiceDecimal(ch) {
  if (!ch) return null;
  return (
    num(ch.decimalValue ?? ch.decimal)
    || fractionalToDecimal(ch.fractionalValue)
    || fractionalToDecimal(ch.fractional)
  );
}

function extractMarkets(payload) {
  if (Array.isArray(payload?.markets)) return payload.markets;
  if (Array.isArray(payload?.odds?.markets)) return payload.odds.markets;
  if (Array.isArray(payload?.odd?.markets)) return payload.odd.markets;
  return [];
}

function extractFullTime(payload) {
  const markets = extractMarkets(payload);
  const market = markets.find((m) => {
    const name = String(m.marketName || m.name || '').toLowerCase();
    return name === 'full time' || name === 'full-time' || name === 'winner' || name === 'home/away';
  }) || markets[0];
  if (!market) return null;
  const choices = {};
  for (const ch of asArray(market.choices || market.outcomes)) {
    const key = String(ch.name ?? ch.choice ?? '');
    choices[key] = {
      fractional: ch.fractionalValue || ch.fractional || null,
      initial_fractional: ch.initialFractionalValue || null,
      decimal: choiceDecimal(ch),
      initial_decimal: fractionalToDecimal(ch.initialFractionalValue),
      change: num(ch.change) ?? 0,
    };
  }
  const home = choices['1'] || choices.home || choices.Home;
  const away = choices['2'] || choices.away || choices.Away;
  if (!home?.decimal && !away?.decimal) return null;
  return {
    marketName: market.marketName || market.name || 'Full time',
    isLive: !!market.isLive,
    suspended: !!market.suspended,
    source: 'allsportsapi2',
    bookmaker: 'AllSports',
    home,
    away,
    choices,
  };
}

function impliedPair(homeDec, awayDec) {
  const h = Number(homeDec);
  const a = Number(awayDec);
  if (!(h > 1) || !(a > 1)) return { home: null, away: null };
  const rawH = 1 / h;
  const rawA = 1 / a;
  const sum = rawH + rawA;
  return {
    home: Math.round((rawH / sum) * 1000) / 10,
    away: Math.round((rawA / sum) * 1000) / 10,
  };
}

function parseVotePercents(payload) {
  const vote = payload?.vote || payload;
  const v1 = num(vote?.vote1 ?? vote?.home ?? vote?.percent1);
  const v2 = num(vote?.vote2 ?? vote?.away ?? vote?.percent2);
  if (v1 == null || v2 == null) return null;
  const sum = v1 + v2;
  if (sum <= 0) return null;
  if (v1 + v2 <= 1.01) {
    return { home: Math.round(v1 * 1000) / 10, away: Math.round(v2 * 1000) / 10 };
  }
  if (v1 <= 100 && v2 <= 100 && Math.abs(sum - 100) < 8) {
    return { home: Math.round(v1 * 10) / 10, away: Math.round(v2 * 10) / 10 };
  }
  return {
    home: Math.round((v1 / sum) * 1000) / 10,
    away: Math.round((v2 / sum) * 1000) / 10,
  };
}

function parsePlayerRankRows(payload) {
  const official = { current: null, previous: null, best: null, live: null, utr: null, points: null };
  for (const row of flattenRankRows(payload)) {
    const cls = String(row.rankingClass || '').toLowerCase();
    const type = row.type;
    if (cls === 'utr' || type === 34 || type === 35) {
      official.utr = num(row.ranking);
    } else if (cls === 'livetennis' || type === 7 || type === 8) {
      official.live = num(row.ranking);
    } else if (cls === 'team' || type === 5 || type === 6 || official.current == null) {
      official.current = num(row.ranking ?? official.current);
      official.previous = num(row.previousRanking ?? official.previous);
      official.best = num(row.bestRanking ?? official.best);
      official.points = num(row.points ?? official.points);
    }
  }
  return official;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return out;
}

function keepEvent(ev) {
  const slug = eventTourSlug(ev);
  if (slug && slug !== 'atp' && slug !== 'wta') return false;
  const points = eventTennisPoints(ev);
  if (points != null && TOUR_POINTS.size && !TOUR_POINTS.has(points)) return false;
  return true;
}

function slimEvent(ev) {
  const points = eventTennisPoints(ev);
  const tournament = ev.tournament || {};
  const unique = tournament.uniqueTournament || {};
  const home = slimPlayer(ev.homeTeam);
  const away = slimPlayer(ev.awayTeam);
  const tour = (eventTourSlug(ev) || 'atp').toUpperCase();
  let gender = home.gender || away.gender;
  if (!gender) gender = tour === 'WTA' ? 'F' : 'M';
  const status = ev.status || {};
  return {
    id: ev.id,
    level: tourLevelLabel(points, tour.toLowerCase()),
    tour,
    tennisPoints: points,
    tournament: tournament.name || unique.name,
    tournamentShort: unique.name || tournament.name,
    status: status.description || status.type || null,
    statusType: status.type || null,
    home: home.name,
    away: away.name,
    homePlayer: home,
    awayPlayer: away,
    homeScore: num(ev.homeScore?.current ?? ev.homeScore),
    awayScore: num(ev.awayScore?.current ?? ev.awayScore),
    startTimestamp: num(ev.startTimestamp),
    roundInfo: ev.roundInfo || null,
    roundLabel: roundLabel(ev.roundInfo),
    groundType: ev.groundType || unique.groundType || null,
    groundLabel: groundLabel(ev.groundType || unique.groundType),
    gender,
    slug: ev.slug,
    customId: ev.customId,
  };
}

function flattenRankRows(payload) {
  const rows = [];
  const top = asArray(payload?.rankings);
  for (const row of top) {
    if (Array.isArray(row?.rankings)) rows.push(...row.rankings);
    else if (row?.team || row?.ranking != null) rows.push(row);
  }
  return rows;
}

function rankingsFromPayload(payload, into = {}, { liveOnly = false } = {}) {
  for (const row of flattenRankRows(payload)) {
    const team = row.team || {};
    const id = team.id ?? row.teamId ?? row.id;
    if (id == null) continue;
    const pid = String(id);
    const rank = num(row.ranking ?? team.ranking);
    if (!into[pid]) {
      into[pid] = {
        current: liveOnly ? null : rank,
        previous: liveOnly ? null : num(row.previousRanking),
        best: liveOnly ? null : num(row.bestRanking),
        live: liveOnly ? rank : num(row.liveRanking),
        utr: null,
        points: liveOnly ? null : num(row.points),
        unavailable: false,
      };
    } else if (liveOnly) {
      into[pid].live = rank;
    } else {
      if (into[pid].current == null) into[pid].current = rank;
      if (into[pid].previous == null) into[pid].previous = num(row.previousRanking);
      if (into[pid].best == null) into[pid].best = num(row.bestRanking);
      if (into[pid].points == null) into[pid].points = num(row.points);
    }
  }
  return into;
}

async function loadRankingsByPlayer() {
  const now = Date.now();
  if (rankCache.map && now - rankCache.at < RANK_CACHE_MS) return rankCache.map;
  const [atp, wta, atpLive, wtaLive] = await Promise.all([
    rapidGet('/api/tennis/rankings/atp'),
    rapidGet('/api/tennis/rankings/wta'),
    rapidGet('/api/tennis/rankings/atp/live').catch(() => ({})),
    rapidGet('/api/tennis/rankings/wta/live').catch(() => ({})),
  ]);
  const map = {};
  rankingsFromPayload(atp, map);
  rankingsFromPayload(wta, map);
  rankingsFromPayload(atpLive, map, { liveOnly: true });
  rankingsFromPayload(wtaLive, map, { liveOnly: true });
  rankCache = { at: now, map };
  return map;
}

const playerCache = new Map();
const PLAYER_CACHE_MS = Number(process.env.ALLSPORTS_PLAYER_CACHE_MS || 6 * 60 * 60_000);

async function enrichPlayers(events, rankingsByPlayer) {
  const ids = [];
  const seen = new Set();
  for (const ev of events) {
    for (const side of [ev.homePlayer, ev.awayPlayer]) {
      if (!side?.id || seen.has(String(side.id))) continue;
      seen.add(String(side.id));
      const hit = rankingsByPlayer[String(side.id)];
      if (!hit?.best || !side.birthYear) ids.push(side.id);
    }
  }
  const cap = Number(process.env.ALLSPORTS_PLAYER_ENRICH_MAX || 24);
  const todo = ids.slice(0, cap);
  await mapLimit(todo, 3, async (id) => {
    const key = String(id);
    const cached = playerCache.get(key);
    if (cached && Date.now() - cached.at < PLAYER_CACHE_MS) {
      applyPlayerEnrichment(events, rankingsByPlayer, key, cached);
      return;
    }
    try {
      const [teamPayload, rankPayload] = await Promise.all([
        rapidGet(`/api/tennis/team/${id}`).catch(() => rapidGet(`/api/tennis/player/${id}`)),
        rapidGet(`/api/tennis/team/${id}/rankings`).catch(() => rapidGet(`/api/tennis/player/${id}/rankings`)),
      ]);
      const team = teamPayload.team || teamPayload.player || teamPayload;
      const detail = {
        at: Date.now(),
        birthYear: birthYearOf(team),
        ranks: parsePlayerRankRows(rankPayload),
      };
      playerCache.set(key, detail);
      applyPlayerEnrichment(events, rankingsByPlayer, key, detail);
    } catch (err) {
      console.warn(`[allsports] player ${id} enrich failed`, err.message);
    }
  });
}

function applyPlayerEnrichment(events, rankingsByPlayer, pid, detail) {
  const ranks = detail.ranks || {};
  const prev = rankingsByPlayer[pid] || {};
  rankingsByPlayer[pid] = {
    current: prev.current ?? ranks.current,
    previous: prev.previous ?? ranks.previous,
    best: prev.best ?? ranks.best,
    live: prev.live ?? ranks.live,
    utr: prev.utr ?? ranks.utr,
    points: prev.points ?? ranks.points,
    unavailable: false,
  };
  if (!detail.birthYear) return;
  for (const ev of events) {
    for (const key of ['homePlayer', 'awayPlayer']) {
      if (ev[key] && String(ev[key].id) === pid) {
        ev[key].birthYear = detail.birthYear;
        ev[key].age = ageFromBirthYear(detail.birthYear);
      }
    }
  }
}

function collectOddsByEvent(payload) {
  const out = {};
  const events = extractEvents(payload);
  const extra = asArray(payload?.odds);
  for (const ev of events) {
    const ft = extractFullTime(ev.odds || ev);
    if (!ev?.id || !ft) continue;
    out[String(ev.id)] = {
      eventId: ev.id,
      source: 'allsportsapi2',
      full_time: ft,
    };
  }
  for (const row of extra) {
    const id = row.eventId || row.id || row.event?.id;
    const ft = extractFullTime(row);
    if (!id || !ft || out[String(id)]) continue;
    out[String(id)] = { eventId: id, source: 'allsportsapi2', full_time: ft };
  }
  return { events, oddsByEvent: out };
}

function extractCategories(payload) {
  if (Array.isArray(payload?.categories)) return payload.categories;
  if (Array.isArray(payload?.category)) return payload.category;
  return asArray(payload);
}

function extractEvents(payload) {
  if (Array.isArray(payload?.events)) return payload.events;
  return asArray(payload);
}

async function loadDayEvents(parts) {
  let categories = [];
  try {
    const cal = await rapidGet(
      `/api/tennis/calendar/${parts.day}/${parts.month}/${parts.year}/categories`,
    );
    categories = extractCategories(cal).filter(isAtpWtaCategory);
  } catch (err) {
    console.warn('[allsports] calendar failed, fallback ATP/WTA ids', err.message);
  }
  if (!categories.length) {
    categories = [
      { id: 3, slug: 'atp', name: 'ATP' },
      { id: 6, slug: 'wta', name: 'WTA' },
    ];
  }

  const packs = await Promise.all(
    categories.map(async (cat) => {
      try {
        const data = await rapidGet(
          `/api/tennis/category/${cat.id}/events/${parts.day}/${parts.month}/${parts.year}`,
        );
        return extractEvents(data);
      } catch (err) {
        console.warn(`[allsports] category ${cat.id} events failed`, err.message);
        return [];
      }
    }),
  );

  let liveEvents = [];
  try {
    liveEvents = extractEvents(await rapidGet('/api/tennis/events/live'));
  } catch (err) {
    console.warn('[allsports] live failed', err.message);
  }

  let oddsPack = { events: [], oddsByEvent: {} };
  try {
    oddsPack = collectOddsByEvent(
      await rapidGet(`/api/tennis/events/odds/${parts.day}/${parts.month}/${parts.year}`),
    );
  } catch (err) {
    console.warn('[allsports] day odds failed', err.message);
  }

  const byId = new Map();
  for (const ev of [...packs.flat(), ...liveEvents, ...oddsPack.events]) {
    if (!ev?.id || !keepEvent(ev)) continue;
    byId.set(ev.id, ev);
  }
  return { events: [...byId.values()], oddsByEvent: oddsPack.oddsByEvent };
}

function groupTournaments(events) {
  const groups = new Map();
  for (const ev of events) {
    const slim = slimEvent(ev);
    const tournament = ev.tournament || {};
    const unique = tournament.uniqueTournament || {};
    const key = String(unique.id || tournament.id || slim.tournament || 'other');
    if (!groups.has(key)) {
      groups.set(key, {
        name: slim.tournament,
        level: slim.level,
        tour: slim.tour,
        tournamentId: num(tournament.id),
        uniqueTournamentId: num(unique.id),
        seasonId: num(ev.season?.id || tournament.season?.id),
        tennisPoints: slim.tennisPoints,
        events: [],
      });
    }
    groups.get(key).events.push(slim);
  }
  return [...groups.values()].sort((a, b) =>
    String(a.tour).localeCompare(String(b.tour)) || String(a.name).localeCompare(String(b.name)),
  );
}

function seedMissingRanks(events, rankingsByPlayer) {
  for (const ev of events) {
    for (const side of [ev.homePlayer, ev.awayPlayer]) {
      if (!side?.id) continue;
      const pid = String(side.id);
      const hit = rankingsByPlayer[pid];
      if (!hit) {
        rankingsByPlayer[pid] = {
          current: num(side.ranking),
          previous: null,
          best: null,
          live: null,
          utr: null,
        };
      } else if (hit.current == null && side.ranking != null) {
        hit.current = num(side.ranking);
      }
    }
  }
  return rankingsByPlayer;
}

function buildModelAndMarket(slimEvents, oddsByEvent) {
  const eloByEvent = {};
  const marketByEvent = {};
  const birthYearByPlayer = {};
  for (const ev of slimEvents) {
    for (const side of [ev.homePlayer, ev.awayPlayer]) {
      if (side?.id && side.birthYear) birthYearByPlayer[String(side.id)] = side.birthYear;
    }
    const odds = oddsByEvent[String(ev.id)];
    const ft = odds?.full_time;
    const implied = impliedPair(ft?.home?.decimal, ft?.away?.decimal);
    if (implied.home != null) {
      marketByEvent[String(ev.id)] = {
        title: `${ev.home} vs ${ev.away}`,
        url: '',
        source: 'allsportsapi2',
        home_outcome: ev.home,
        away_outcome: ev.away,
        home_price: implied.home / 100,
        away_price: implied.away / 100,
        moneyline: {
          outcomes: [ev.home, ev.away],
          prices: [implied.home / 100, implied.away / 100],
        },
      };
    }
    const homeWin = implied.home;
    const awayWin = implied.away;
    if (homeWin == null || awayWin == null) continue;
    const homeEdge = 0;
    const awayEdge = 0;
    const homeBetter = homeWin >= awayWin;
    eloByEvent[String(ev.id)] = {
      ok: true,
      surface: ev.groundLabel || ev.groundType || null,
      ratingSource: 'AllSports 去汁隐含概率',
      home: {
        name: ev.home,
        matched: true,
        age: ev.homePlayer?.age ?? null,
        short: shortNameOf(ev.home),
        win_pct: homeWin,
        implied_pct: homeWin,
        edge_pct: homeEdge,
      },
      away: {
        name: ev.away,
        matched: true,
        age: ev.awayPlayer?.age ?? null,
        short: shortNameOf(ev.away),
        win_pct: awayWin,
        implied_pct: awayWin,
        edge_pct: awayEdge,
      },
      best: {
        side: homeBetter ? 'home' : 'away',
        name: homeBetter ? ev.home : ev.away,
        short: shortNameOf(homeBetter ? ev.home : ev.away),
        edge_pct: null,
        win_pct: homeBetter ? homeWin : awayWin,
      },
    };
  }
  return { eloByEvent, marketByEvent, birthYearByPlayer };
}

async function attachVotes(slimEvents, eloByEvent, oddsByEvent) {
  const pending = slimEvents.filter((ev) => {
    const st = String(ev.statusType || '').toLowerCase();
    return st === 'notstarted' || st === 'not started' || ev.status === 'Not started';
  }).slice(0, Number(process.env.ALLSPORTS_VOTE_MAX || 20));
  await mapLimit(pending, 3, async (ev) => {
    try {
      const votes = parseVotePercents(await rapidGet(`/api/tennis/event/${ev.id}/votes`));
      if (!votes) return;
      const implied = impliedPair(
        oddsByEvent[String(ev.id)]?.full_time?.home?.decimal,
        oddsByEvent[String(ev.id)]?.full_time?.away?.decimal,
      );
      const homeEdge = implied.home == null ? null : Math.round((votes.home - implied.home) * 10) / 10;
      const awayEdge = implied.away == null ? null : Math.round((votes.away - implied.away) * 10) / 10;
      const homeBetter = votes.home >= votes.away;
      const bestEdge = homeBetter ? homeEdge : awayEdge;
      eloByEvent[String(ev.id)] = {
        ok: true,
        surface: ev.groundLabel || ev.groundType || null,
        ratingSource: 'AllSports 投票 vs 隐含盘',
        home: {
          name: ev.home,
          matched: true,
          age: ev.homePlayer?.age ?? null,
          short: shortNameOf(ev.home),
          win_pct: votes.home,
          implied_pct: implied.home,
          edge_pct: homeEdge,
        },
        away: {
          name: ev.away,
          matched: true,
          age: ev.awayPlayer?.age ?? null,
          short: shortNameOf(ev.away),
          win_pct: votes.away,
          implied_pct: implied.away,
          edge_pct: awayEdge,
        },
        best: {
          side: homeBetter ? 'home' : 'away',
          name: homeBetter ? ev.home : ev.away,
          short: shortNameOf(homeBetter ? ev.home : ev.away),
          edge_pct: bestEdge,
          win_pct: homeBetter ? votes.home : votes.away,
        },
      };
    } catch (err) {
      console.warn(`[allsports] votes ${ev.id} failed`, err.message);
    }
  });
}

async function buildTodayBundle() {
  const parts = todayParts();
  const [day, rankings] = await Promise.all([
    loadDayEvents(parts),
    loadRankingsByPlayer(),
  ]);
  const rawEvents = day.events || [];
  const oddsByEvent = { ...(day.oddsByEvent || {}) };
  const scheduledTournaments = groupTournaments(rawEvents);
  const slimEvents = scheduledTournaments.flatMap((t) => t.events);
  const rankingsByPlayer = seedMissingRanks(slimEvents, { ...rankings });
  await enrichPlayers(slimEvents, rankingsByPlayer);

  const liveTournaments = [];
  for (const t of scheduledTournaments) {
    const liveEvents = (t.events || []).filter((e) => {
      const st = String(e.statusType || '').toLowerCase();
      return st === 'inprogress' || st === 'live';
    });
    if (liveEvents.length) liveTournaments.push({ ...t, events: liveEvents });
  }

  const { eloByEvent, marketByEvent, birthYearByPlayer } = buildModelAndMarket(slimEvents, oddsByEvent);
  await attachVotes(slimEvents, eloByEvent, oddsByEvent);

  const eventCount = slimEvents.length;
  const oddsCount = Object.keys(oddsByEvent).length;
  return {
    sport: 'tennis',
    date: parts.iso,
    fetched_at: new Date().toISOString(),
    source: 'allsportsapi2',
    filter: 'atp-wta-tour',
    top_rank_max: 50,
    exclude_ended: false,
    update: {
      message: `AllSportsAPI2 · ${eventCount} 场 · ${oddsCount} 盘`,
      at: new Date().toISOString(),
    },
    scheduled: {
      tournaments: scheduledTournaments,
      tournamentCount: scheduledTournaments.length,
      eventCount,
    },
    live: {
      tournaments: liveTournaments,
      matches: liveTournaments.flatMap((t) => t.events),
      tournamentCount: liveTournaments.length,
      eventCount: liveTournaments.reduce((n, t) => n + (t.events?.length || 0), 0),
    },
    rankingsByPlayer,
    oddsByEvent,
    eloByEvent,
    polymarketByEvent: {},
    theOddsApiByEvent: {},
    birthYearByPlayer,
    ok: true,
    member: true,
    events: eventCount,
    message: `allsportsapi2 · ${eventCount} events`,
  };
}

async function loadTodayBundle() {
  const now = Date.now();
  if (scheduleCache.bundle && now - scheduleCache.at < CACHE_MS) {
    return scheduleCache.bundle;
  }
  if (inflight) return inflight;
  inflight = buildTodayBundle()
    .then((bundle) => {
      scheduleCache = { at: Date.now(), bundle };
      return bundle;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

module.exports = {
  isConfigured,
  loadTodayBundle,
  todayParts,
};
