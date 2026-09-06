/**
 * 为 Sofascore monitor bundle 补齐 polymarketByEvent（MySQL 已有则优先，否则 Gamma 按球员名匹配）。
 */
const pool = require('../db');
const { parsePrices } = require('./tennisPolymarket');

const GAMMA = 'https://gamma-api.polymarket.com';
const TENNIS_TAG_ID = Number(process.env.POLY_TENNIS_TAG_ID || 864);
const CACHE_MS = Number(process.env.POLY_TENNIS_CACHE_MS || 120000);

let polyCache = { at: 0, items: [] };

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(name) {
  const n = normalizeName(name);
  if (!n) return [];
  return n.split(' ').filter((t) => t.length >= 2);
}

function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.length || !tb.length) return false;
  const setB = new Set(tb);
  const overlap = ta.filter((t) => setB.has(t));
  if (overlap.length >= Math.min(ta.length, tb.length)) return true;
  if (overlap.length >= 1 && Math.min(ta.length, tb.length) === 1) return true;
  return false;
}

function parseOutcomes(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* ignore */
    }
  }
  return [];
}

function pickMoneylineMarket(markets) {
  for (const m of markets || []) {
    const outs = parseOutcomes(m?.outcomes);
    if (outs.length >= 2 && !/^(yes|no)$/i.test(outs[0])) return m;
  }
  return (markets || [])[0] || null;
}

function extractEventSides(ev) {
  const title = String(ev?.title || '');
  let m = title.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s*\(|\s+-|$)/i);
  if (m) return [m[1].trim(), m[2].trim()];
  m = title.match(/will\s+(.+?)\s+beat\s+(.+?)\??$/i);
  if (m) return [m[1].trim(), m[2].trim()];
  const mk = pickMoneylineMarket(ev?.markets);
  const outs = parseOutcomes(mk?.outcomes);
  if (outs.length >= 2) return [outs[0], outs[1]];
  return [null, null];
}

async function fetchPolymarketTennisEvents() {
  const now = Date.now();
  if (polyCache.items.length && now - polyCache.at < CACHE_MS) {
    return polyCache.items;
  }
  const urls = [
    `${GAMMA}/events?tag_id=${TENNIS_TAG_ID}&active=true&closed=false&limit=200`,
    `${GAMMA}/events?tag_slug=tennis&active=true&closed=false&limit=100`,
  ];
  const bySlug = new Map();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'yuce-bid/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return;
        const list = await res.json();
        for (const ev of list || []) {
          if (!ev?.slug) continue;
          bySlug.set(ev.slug, ev);
        }
      } catch (e) {
        console.warn('[tennis/poly-match] gamma:', e.message || e);
      }
    }),
  );
  const items = [...bySlug.values()].map((ev) => {
    const [sideA, sideB] = extractEventSides(ev);
    const mk = pickMoneylineMarket(ev.markets);
    const prices = parsePrices(mk);
    return {
      slug: ev.slug,
      title: ev.title || '',
      url: `https://polymarket.com/event/${ev.slug}`,
      sideA,
      sideB,
      prices,
      startMs: ev.startDate ? Date.parse(ev.startDate) : NaN,
      endMs: ev.endDate ? Date.parse(ev.endDate) : NaN,
    };
  });
  polyCache = { at: now, items };
  return items;
}

function matchSides(home, away, events) {
  if (!home || !away || !events.length) return null;
  let best = null;
  let bestScore = -1;
  for (const ev of events) {
    if (!ev.sideA || !ev.sideB) continue;
    const same =
      (namesMatch(home, ev.sideA) && namesMatch(away, ev.sideB)) ||
      (namesMatch(home, ev.sideB) && namesMatch(away, ev.sideA));
    if (!same) continue;
    let score = 10;
    if (Number.isFinite(ev.startMs)) {
      score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }
  if (!best || bestScore < 10) return null;
  return best;
}

function collectBundleMatches(bundle) {
  const out = [];
  const seen = new Set();
  const push = (m) => {
    if (!m?.id || seen.has(String(m.id))) return;
    seen.add(String(m.id));
    out.push(m);
  };
  for (const t of bundle?.scheduled?.tournaments || []) {
    for (const e of t.events || []) push(e);
  }
  for (const m of bundle?.live?.matches || []) push(m);
  return out;
}

async function loadMysqlPolymarket(eventIds) {
  const map = {};
  if (!eventIds.length) return map;
  try {
    const [rows] = await pool.query(
      `SELECT id, home_name, away_name, polymarket_url, polymarket_title,
              poly_home_price, poly_away_price
       FROM tennis_matches
       WHERE polymarket_url IS NOT NULL AND polymarket_url != ''
         AND (id IN (?) OR match_date >= CURDATE() - INTERVAL 2 DAY)`,
      [eventIds],
    );
    const byId = new Map();
    const byName = [];
    for (const row of rows) {
      byId.set(String(row.id), row);
      byName.push(row);
    }
    for (const id of eventIds) {
      const row = byId.get(String(id));
      if (row?.polymarket_url) {
        map[String(id)] = rowToPoly(row);
      }
    }
    return { map, byName, byId };
  } catch (e) {
    console.warn('[tennis/poly-match] mysql:', e.message || e);
    return { map: {}, byName: [], byId: new Map() };
  }
}

function rowToPoly(row) {
  return {
    title: row.polymarket_title || `${row.home_name} vs ${row.away_name}`,
    url: row.polymarket_url,
    moneyline: {
      outcomes: [row.home_name, row.away_name],
      prices: [num(row.poly_home_price) ?? 0.5, num(row.poly_away_price) ?? 0.5],
    },
  };
}

function matchMysqlRow(m, rows) {
  const home = m.homePlayer?.name || m.home;
  const away = m.awayPlayer?.name || m.away;
  for (const row of rows) {
    if (
      (namesMatch(home, row.home_name) && namesMatch(away, row.away_name)) ||
      (namesMatch(home, row.away_name) && namesMatch(away, row.home_name))
    ) {
      return row;
    }
  }
  return null;
}

/**
 * @returns {{ matched: number, fromMysql: number, fromGamma: number }}
 */
async function enrichBundlePolymarket(bundle) {
  if (!bundle || typeof bundle !== 'object') return { matched: 0, fromMysql: 0, fromGamma: 0 };
  const matches = collectBundleMatches(bundle);
  if (!matches.length) return { matched: 0, fromMysql: 0, fromGamma: 0 };

  const polyMap = { ...(bundle.polymarketByEvent || {}) };
  const eventIds = matches.map((m) => Number(m.id)).filter((id) => Number.isFinite(id));

  const mysql = await loadMysqlPolymarket(eventIds);
  let fromMysql = 0;
  let fromGamma = 0;

  for (const m of matches) {
    const id = String(m.id);
    if (polyMap[id]?.url) continue;
    if (mysql.map[id]) {
      polyMap[id] = mysql.map[id];
      fromMysql += 1;
      continue;
    }
    const row = matchMysqlRow(m, mysql.byName || []);
    if (row) {
      polyMap[id] = rowToPoly(row);
      fromMysql += 1;
    }
  }

  const needGamma = matches.filter((m) => !polyMap[String(m.id)]?.url);
  if (needGamma.length) {
    const events = await fetchPolymarketTennisEvents();
    for (const m of needGamma) {
      const home = m.homePlayer?.name || m.home;
      const away = m.awayPlayer?.name || m.away;
      const hit = matchSides(home, away, events);
      if (!hit) continue;
      polyMap[String(m.id)] = {
        title: hit.title,
        url: hit.url,
        slug: hit.slug,
        moneyline: hit.prices
          ? { outcomes: [hit.sideA, hit.sideB], prices: hit.prices }
          : { outcomes: [hit.sideA, hit.sideB], prices: [0.5, 0.5] },
      };
      fromGamma += 1;
    }
  }

  bundle.polymarketByEvent = polyMap;
  const matched = Object.keys(polyMap).filter((k) => polyMap[k]?.url).length;
  if (fromMysql || fromGamma) {
    console.log(
      `[tennis/poly-match] linked=${matched} mysql=${fromMysql} gamma=${fromGamma} pool=${matches.length}`,
    );
  }
  return { matched, fromMysql, fromGamma };
}

module.exports = {
  enrichBundlePolymarket,
  fetchPolymarketTennisEvents,
  namesMatch,
};
