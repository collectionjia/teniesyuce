/**
 * Polymarket Dota2 盘口采集：Gamma → dota2elo 匹配/预测 → 阈值过滤 → Redis
 */
const redis = require('./redis');

const BUNDLE_KEY = 'dota2:bundle:pm';
const GAMMA = 'https://gamma-api.polymarket.com';
const DEFAULT_ELO_DIFF_MIN = 150;
const DEFAULT_WIN_PROB_MIN = 0.65;
const COLLECT_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.DOTA2_PM_COLLECT_MS || 90_000) || 90_000,
);

let collectBusy = false;
let intervalHandle = null;
/** Redis 不可用时的进程内兜底（本机开发常见） */
let memoryBundle = null;

function thresholds() {
  const eloDiffMin = Number(process.env.DOTA2_ELO_DIFF_MIN);
  const winProbMin = Number(process.env.DOTA2_WIN_PROB_MIN);
  return {
    eloDiffMin: Number.isFinite(eloDiffMin) && eloDiffMin > 0 ? eloDiffMin : DEFAULT_ELO_DIFF_MIN,
    winProbMin: Number.isFinite(winProbMin) && winProbMin > 0 && winProbMin < 1
      ? winProbMin
      : DEFAULT_WIN_PROB_MIN,
  };
}

function upstreamBase() {
  const raw = process.env.DOTA2ELO_URL
    || process.env.DOTA2ELO_PRODUCT_URL
    || 'http://dota2elo:3001';
  return String(raw).replace(/\/+$/, '');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'yuce-bid/dota2-pm/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function parseJsonField(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  return raw;
}

function parseOutcomes(raw) {
  const parsed = parseJsonField(raw, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function parsePrices(mkt) {
  if (!mkt) return null;
  let prices = parseJsonField(mkt.outcomePrices, null);
  if (!Array.isArray(prices) || prices.length < 2) {
    prices = parseJsonField(mkt.prices, null);
  }
  if (!Array.isArray(prices) || prices.length < 2) return null;
  const a = Number(prices[0]);
  const b = Number(prices[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function parseTokenIds(mkt) {
  const tokens = parseJsonField(mkt?.clobTokenIds, []);
  if (!Array.isArray(tokens)) return [];
  return tokens.map(String).filter(Boolean);
}

function pickMoneylineMarket(markets) {
  for (const mkt of markets || []) {
    const outs = parseOutcomes(mkt.outcomes);
    if (outs.length >= 2 && !/^(yes|no)$/i.test(outs[0])) return mkt;
  }
  return (markets || [])[0] || null;
}

function extractEventSides(ev) {
  const title = String(ev?.title || '');
  const chunks = [];
  if (title.includes(':')) chunks.push(title.split(':').slice(1).join(':').trim());
  chunks.push(title);
  for (const chunk of chunks) {
    const m = chunk.match(/([\w][\w\s.\-']*?)\s+vs\.?\s+([\w][\w\s.\-']*?)(?:\s*\(|\s+-|$)/i);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  const will = title.match(/will\s+(.+?)\s+beat\s+(.+?)\??$/i);
  if (will) return [will[1].trim(), will[2].trim()];
  return [null, null];
}

function slimGammaEvent(ev) {
  const mk = pickMoneylineMarket(ev.markets || []);
  const prices = parsePrices(mk);
  const tokens = parseTokenIds(mk);
  const outcomes = parseOutcomes(mk?.outcomes);
  let [sideA, sideB] = extractEventSides(ev);
  // title 解析失败时，用 moneyline outcomes 作为队名
  if ((!sideA || !sideB) && outcomes.length >= 2
    && !/^(yes|no)$/i.test(outcomes[0])
    && !/^(yes|no)$/i.test(outcomes[1])) {
    sideA = outcomes[0];
    sideB = outcomes[1];
  }
  const slug = String(ev?.slug || '');
  return {
    slug,
    title: ev?.title || '',
    url: slug ? `https://polymarket.com/event/${slug}` : '',
    sideA,
    sideB,
    prices,
    tokenIds: tokens,
    outcomes,
    closed: !!ev?.closed,
    active: ev?.active,
    startMs: ev?.startDate ? Date.parse(ev.startDate) : null,
  };
}

function isSportMatchEvent(item) {
  const sideA = String(item.sideA || '').trim();
  const sideB = String(item.sideB || '').trim();
  if (!sideA || !sideB) return false;
  if (/^(yes|no)$/i.test(sideA) || /^(yes|no)$/i.test(sideB)) return false;
  const blob = `${item.title || ''} ${item.slug || ''}`;
  if (!/\bvs\.?\b/i.test(blob)) return false;
  const lowSlug = String(item.slug || '').toLowerCase();
  const lowTitle = String(item.title || '').toLowerCase();
  if (lowSlug.includes('more-markets') || lowTitle.includes('more markets')) return false;
  if (lowTitle.startsWith('will ') || lowSlug.startsWith('will-')) return false;
  if (lowSlug.includes('champion') && !lowSlug.includes('vs')) return false;
  return true;
}

function isOpenPricedMatch(item, eps = 0.005) {
  if (item.closed) return false;
  const prices = item.prices;
  if (!Array.isArray(prices) || prices.length < 2) return false;
  const a = Number(prices[0]);
  const b = Number(prices[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a <= eps || a >= 1 - eps || b <= eps || b >= 1 - eps) return false;
  return true;
}

async function fetchPolymarketDotaEvents() {
  const tagSlug = (process.env.POLY_DOTA_TAG_SLUG || 'dota-2').trim() || 'dota-2';
  const tagIdRaw = (process.env.POLY_DOTA_TAG_ID || '').trim();
  const tagId = /^\d+$/.test(tagIdRaw) ? Number(tagIdRaw) : null;
  const bySlug = new Map();
  const pageSize = 100;
  const maxOffset = 500;

  for (let offset = 0; offset <= maxOffset; offset += pageSize) {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(pageSize),
      offset: String(offset),
    });
    if (tagId != null) params.set('tag_id', String(tagId));
    else params.set('tag_slug', tagSlug);
    let rows;
    try {
      rows = await fetchJson(`${GAMMA}/events?${params}`);
    } catch (err) {
      console.warn('[dota2-pm] gamma page skip', err.message || err);
      break;
    }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const ev of rows) {
      if (ev?.slug) bySlug.set(String(ev.slug), ev);
    }
    if (rows.length < pageSize) break;
  }

  return [...bySlug.values()]
    .map(slimGammaEvent)
    .filter((x) => !x.closed && isSportMatchEvent(x) && isOpenPricedMatch(x));
}

function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\b(esports?|gaming|team|club|org|official)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameScore(query, candidate) {
  const q = normalizeTeamName(query);
  const c = normalizeTeamName(candidate?.name || candidate?.tag || '');
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 80;
  const qParts = q.split(' ').filter(Boolean);
  const cParts = new Set(c.split(' ').filter(Boolean));
  let hit = 0;
  for (const p of qParts) {
    if (cParts.has(p)) hit += 1;
  }
  if (!hit) return 0;
  return 40 + (hit / Math.max(qParts.length, 1)) * 30;
}

async function matchTeam(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  let list;
  try {
    list = await fetchJson(`${upstreamBase()}/api/teams?q=${encodeURIComponent(q)}`);
  } catch (err) {
    console.warn('[dota2-pm] teams search fail', q, err.message || err);
    return null;
  }
  const rows = Array.isArray(list) ? list : (list?.teams || list?.items || []);
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = Math.max(
      nameScore(q, row),
      nameScore(q, { name: row?.tag }),
    );
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (!best || bestScore < 40) return null;
  return {
    id: Number(best.id),
    name: best.name || best.tag || q,
    tag: best.tag || '',
    rating: best.rating != null ? Number(best.rating) : null,
    score: bestScore,
  };
}

async function predict(aId, bId) {
  const url = `${upstreamBase()}/api/predict?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`;
  return fetchJson(url);
}

function strongProbFromPredict(pred) {
  const pA = Number(
    pred?.upset_adjusted_prob
    ?? pred?.composite_p_a_win
    ?? pred?.p_a_win
    ?? 0.5,
  );
  if (!Number.isFinite(pA)) return { pA: 0.5, strongProb: 0.5, pickSide: 'a' };
  const strongProb = Math.max(pA, 1 - pA);
  const pickSide = pA >= 0.5 ? 'a' : 'b';
  return { pA, strongProb, pickSide };
}

async function enrichEvent(ev, thr) {
  const teamA = await matchTeam(ev.sideA);
  const teamB = await matchTeam(ev.sideB);
  if (!teamA?.id || !teamB?.id || teamA.id === teamB.id) return null;

  let pred;
  try {
    pred = await predict(teamA.id, teamB.id);
  } catch (err) {
    console.warn('[dota2-pm] predict fail', ev.slug, err.message || err);
    return null;
  }

  const ratingA = Number(pred?.team_a_rating ?? teamA.rating);
  const ratingB = Number(pred?.team_b_rating ?? teamB.rating);
  const eloDiff = (Number.isFinite(ratingA) && Number.isFinite(ratingB))
    ? Math.abs(ratingA - ratingB)
    : 0;
  const { pA, strongProb, pickSide } = strongProbFromPredict(pred);
  const isHighConfidence = !!pred?.is_high_confidence;
  const passList = isHighConfidence
    || eloDiff >= thr.eloDiffMin
    || strongProb >= thr.winProbMin;
  // 列表：两侧队名都匹配到 dota2elo 即展示（与网球未开赛一致，先有场次再看强弱）
  // passList / HC 仅作标记；自动投注仍只走 passAutoBet=HC

  const tokens = ev.tokenIds || [];
  const pickTokenId = pickSide === 'a' ? (tokens[0] || null) : (tokens[1] || null);
  const pickName = pickSide === 'a'
    ? (pred?.team_a_name || teamA.name || ev.sideA)
    : (pred?.team_b_name || teamB.name || ev.sideB);
  const pickPrice = Array.isArray(ev.prices)
    ? (pickSide === 'a' ? ev.prices[0] : ev.prices[1])
    : null;

  return {
    slug: ev.slug,
    title: ev.title,
    url: ev.url,
    sideA: ev.sideA,
    sideB: ev.sideB,
    prices: ev.prices,
    tokenIds: tokens,
    outcomes: ev.outcomes,
    startMs: ev.startMs,
    teamA: { id: teamA.id, name: pred?.team_a_name || teamA.name, rating: ratingA },
    teamB: { id: teamB.id, name: pred?.team_b_name || teamB.name, rating: ratingB },
    eloDiff: Math.round(eloDiff * 10) / 10,
    pA: Math.round(pA * 10000) / 10000,
    strongProb: Math.round(strongProb * 10000) / 10000,
    pickSide,
    pickName,
    pickTokenId,
    pickPrice,
    is_high_confidence: isHighConfidence,
    passList,
    passAutoBet: isHighConfidence,
    risk_points: pred?.risk_points ?? null,
  };
}

async function writeBundle(bundle) {
  memoryBundle = bundle;
  const client = await redis.getClient();
  if (!client) return false;
  await client.set(BUNDLE_KEY, JSON.stringify(bundle));
  return true;
}

async function readBundle() {
  const client = await redis.getClient();
  if (client) {
    try {
      const raw = await client.get(BUNDLE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        memoryBundle = parsed;
        return parsed;
      }
    } catch {
      /* fall through to memory */
    }
  }
  return memoryBundle;
}

async function collectOnce() {
  if (collectBusy) return (await readBundle()) || memoryBundle;
  collectBusy = true;
  const thr = thresholds();
  try {
    const events = await fetchPolymarketDotaEvents();
    const matches = [];
    for (const ev of events) {
      try {
        const row = await enrichEvent(ev, thr);
        if (row) matches.push(row);
      } catch (err) {
        console.warn('[dota2-pm] enrich skip', ev?.slug, err.message || err);
      }
    }
    matches.sort((a, b) => {
      if (!!b.is_high_confidence !== !!a.is_high_confidence) {
        return b.is_high_confidence ? 1 : -1;
      }
      if (!!b.passList !== !!a.passList) {
        return b.passList ? 1 : -1;
      }
      return (b.eloDiff || 0) - (a.eloDiff || 0);
    });
    const bundle = {
      ok: true,
      sport: 'dota2',
      source: 'polymarket-gamma',
      fetched_at: new Date().toISOString(),
      thresholds: thr,
      matchCount: matches.length,
      edgeCount: matches.filter((m) => m.passList).length,
      hcCount: matches.filter((m) => m.is_high_confidence).length,
      scanned: events.length,
      matches,
    };
    await writeBundle(bundle);
    console.log(`[dota2-pm] collected ${matches.length}/${events.length} (edge ${bundle.edgeCount} HC ${bundle.hcCount})`);
    return bundle;
  } catch (err) {
    console.error('[dota2-pm] collect failed', err.message || err);
    const prev = await readBundle();
    if (prev) return { ...prev, ok: false, error: err.message || String(err) };
    return {
      ok: false,
      sport: 'dota2',
      matches: [],
      matchCount: 0,
      scanned: 0,
      thresholds: thr,
      fetched_at: new Date().toISOString(),
      error: err.message || String(err),
    };
  } finally {
    collectBusy = false;
  }
}

function placedKey(userId) {
  return `dota2:betting:placed:${userId}`;
}

async function getPlacedSet(userId) {
  const client = await redis.getClient();
  if (!client) return new Set();
  const members = await client.sMembers(placedKey(userId));
  return new Set(members || []);
}

async function markPlaced(userId, slugSide) {
  const client = await redis.getClient();
  if (!client) return;
  const key = placedKey(userId);
  await client.sAdd(key, String(slugSide));
  await client.expire(key, 60 * 60 * 24 * 14);
}

function startCollectLoop() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void collectOnce();
  }, COLLECT_INTERVAL_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  setTimeout(() => { void collectOnce(); }, 8_000);
}

module.exports = {
  BUNDLE_KEY,
  thresholds,
  collectOnce,
  readBundle,
  getPlacedSet,
  markPlaced,
  startCollectLoop,
  placedKey,
};
