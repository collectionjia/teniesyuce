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

let resolvedEloBase = null;

function eloCandidates() {
  const raw = process.env.DOTA2ELO_URL || process.env.DOTA2ELO_PRODUCT_URL;
  if (raw) return [String(raw).replace(/\/+$/, '')];
  return ['http://dota2elo:3001', 'http://127.0.0.1:8893'];
}

async function upstreamBase() {
  if (resolvedEloBase) return resolvedEloBase;
  const list = eloCandidates();
  for (const base of list) {
    try {
      const res = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        resolvedEloBase = base;
        return base;
      }
    } catch {
      /* next */
    }
  }
  return list[0];
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

function parseTimeMs(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  const s = String(raw).trim();
  if (!s) return null;
  // "2026-07-12 09:10:00+00" → ISO-ish
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
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
  // 真实开赛时间优先取 market.gameStartTime / eventStartTime，避免用挂盘 startDate
  const startMs = parseTimeMs(mk?.gameStartTime)
    || parseTimeMs(mk?.eventStartTime)
    || parseTimeMs(ev?.startTime)
    || parseTimeMs(ev?.startDate);
  const endMs = parseTimeMs(mk?.endDate) || parseTimeMs(ev?.endDate);
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
    startMs,
    endMs,
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

/** 未开赛盘：开赛未过太久，且结算截止未过（过滤卡在 Gamma 上的陈旧盘） */
function isUpcomingOrLiveMatch(item, now = Date.now()) {
  const graceMs = Number(process.env.DOTA2_START_GRACE_MS);
  // 默认开赛后仍保留 6 小时（BO3/BO5），更早的一律丢掉
  const startGrace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 6 * 60 * 60 * 1000;
  if (item.endMs != null && Number.isFinite(item.endMs) && item.endMs < now) {
    return false;
  }
  if (item.startMs != null && Number.isFinite(item.startMs)) {
    if (item.startMs < now - startGrace) return false;
  }
  return true;
}

async function fetchPolymarketEventsByTag(tagSlug, tagId) {
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
      console.warn('[pm] gamma page skip', tagSlug, err.message || err);
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
    .filter((x) => !x.closed && isSportMatchEvent(x) && isOpenPricedMatch(x) && isUpcomingOrLiveMatch(x));
}

async function fetchPolymarketDotaEvents() {
  const tagSlug = (process.env.POLY_DOTA_TAG_SLUG || 'dota-2').trim() || 'dota-2';
  const tagIdRaw = (process.env.POLY_DOTA_TAG_ID || '').trim();
  const tagId = /^\d+$/.test(tagIdRaw) ? Number(tagIdRaw) : null;
  return fetchPolymarketEventsByTag(tagSlug, tagId);
}

/** 调度/刷新入口：Polymarket 采集后走 dota2elo 过滤。 */
async function collectDirect() {
  return collectOnce();
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
    list = await fetchJson(`${await upstreamBase()}/api/teams?q=${encodeURIComponent(q)}`);
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
  const base = await upstreamBase();
  const url = `${base}/api/predict?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`;
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

function pmFavoriteSide(prices) {
  const a = Number(prices?.[0]);
  const b = Number(prices?.[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return b > a ? 'b' : 'a';
}

function directionAlign(pickSide, prices) {
  const pmSide = pmFavoriteSide(prices);
  return {
    pmSide,
    align: pmSide && pickSide === pmSide ? '一致' : '不一致',
  };
}

/** 把赔率和 token 对齐到 sideA / sideB（标题顺序和 outcomes 顺序可能相反）。 */
function alignQuoteToSides(ev) {
  const outcomes = Array.isArray(ev.outcomes) ? ev.outcomes : [];
  const prices = Array.isArray(ev.prices) ? ev.prices : [];
  const tokens = Array.isArray(ev.tokenIds) ? ev.tokenIds : [];
  const ia = outcomes.findIndex((o) => normalizeTeamName(o) === normalizeTeamName(ev.sideA));
  const ib = outcomes.findIndex((o) => normalizeTeamName(o) === normalizeTeamName(ev.sideB));
  if (ia < 0 || ib < 0 || ia === ib) return ev;
  return {
    ...ev,
    prices: [prices[ia], prices[ib]],
    tokenIds: [tokens[ia] || null, tokens[ib] || null],
  };
}

async function enrichEvent(ev, thr) {
  ev = alignQuoteToSides(ev);
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
    ...directionAlign(pickSide, ev.prices),
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
    sortEloMatches(matches);
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

function placedKey(userId, sport = 'dota2') {
  const name = sport === 'nfl' ? 'nfl' : 'dota2';
  return `${name}:betting:placed:${userId}`;
}

async function getPlacedSet(userId, sport = 'dota2') {
  const client = await redis.getClient();
  if (!client) return new Set();
  const members = await client.sMembers(placedKey(userId, sport));
  return new Set(members || []);
}

async function markPlaced(userId, slugSide, sport = 'dota2') {
  const client = await redis.getClient();
  if (!client) return;
  const key = placedKey(userId, sport);
  await client.sAdd(key, String(slugSide));
  await client.expire(key, 60 * 60 * 24 * 14);
}

const NFL_BUNDLE_KEY = 'nfl:bundle:pm';
let nflBusy = false;
let nflMemory = null;
let resolvedNflBase = null;

const NFL_NAME_TO_ABBR = {
  cardinals: 'ARI', arizona: 'ARI', ari: 'ARI',
  falcons: 'ATL', atlanta: 'ATL', atl: 'ATL',
  ravens: 'BAL', baltimore: 'BAL', bal: 'BAL',
  bills: 'BUF', buffalo: 'BUF', buf: 'BUF',
  panthers: 'CAR', carolina: 'CAR', car: 'CAR',
  bears: 'CHI', chicago: 'CHI', chi: 'CHI',
  bengals: 'CIN', cincinnati: 'CIN', cin: 'CIN',
  browns: 'CLE', cleveland: 'CLE', cle: 'CLE',
  cowboys: 'DAL', dallas: 'DAL', dal: 'DAL',
  broncos: 'DEN', denver: 'DEN', den: 'DEN',
  lions: 'DET', detroit: 'DET', det: 'DET',
  packers: 'GB', 'green bay': 'GB', gb: 'GB',
  texans: 'HOU', houston: 'HOU', hou: 'HOU',
  colts: 'IND', indianapolis: 'IND', ind: 'IND',
  jaguars: 'JAX', jags: 'JAX', jacksonville: 'JAX', jax: 'JAX',
  chiefs: 'KC', 'kansas city': 'KC', kc: 'KC',
  raiders: 'LV', 'las vegas': 'LV', lv: 'LV',
  chargers: 'LAC', lac: 'LAC',
  rams: 'LA', la: 'LA',
  dolphins: 'MIA', miami: 'MIA', mia: 'MIA',
  vikings: 'MIN', minnesota: 'MIN', min: 'MIN',
  patriots: 'NE', 'new england': 'NE', ne: 'NE',
  saints: 'NO', 'new orleans': 'NO', no: 'NO',
  giants: 'NYG', nyg: 'NYG',
  jets: 'NYJ', nyj: 'NYJ',
  eagles: 'PHI', philadelphia: 'PHI', phi: 'PHI',
  steelers: 'PIT', pittsburgh: 'PIT', pit: 'PIT',
  '49ers': 'SF', niners: 'SF', 'san francisco': 'SF', sf: 'SF',
  seahawks: 'SEA', seattle: 'SEA', sea: 'SEA',
  buccaneers: 'TB', bucs: 'TB', 'tampa bay': 'TB', tb: 'TB',
  titans: 'TEN', tennessee: 'TEN', ten: 'TEN',
  commanders: 'WAS', washington: 'WAS', was: 'WAS',
};

function nflAbbr(name) {
  const n = normalizeTeamName(name);
  if (!n) return null;
  if (NFL_NAME_TO_ABBR[n]) return NFL_NAME_TO_ABBR[n];
  const parts = n.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    const tail2 = parts.slice(-2).join(' ');
    if (NFL_NAME_TO_ABBR[tail2]) return NFL_NAME_TO_ABBR[tail2];
  }
  const last = parts[parts.length - 1];
  return NFL_NAME_TO_ABBR[last] || null;
}

async function nfleloBase() {
  if (resolvedNflBase) return resolvedNflBase;
  const raw = process.env.NFLELO_URL;
  const list = raw
    ? [String(raw).replace(/\/+$/, '')]
    : ['http://nflelo:8000', 'http://127.0.0.1:8894'];
  for (const base of list) {
    try {
      const res = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        resolvedNflBase = base;
        return base;
      }
    } catch {
      /* next */
    }
  }
  return list[0];
}

async function predictNfl(abbrA, abbrB) {
  const base = await nfleloBase();
  const res = await fetch(`${base}/api/predict`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      team_a: abbrA,
      team_b: abbrB,
      neutral: true,
      use_xgb_ensemble: false,
    }),
  });
  if (!res.ok) throw new Error(`nflelo HTTP ${res.status}`);
  return res.json();
}

async function enrichNflEvent(ev, thr) {
  ev = alignQuoteToSides(ev);
  const abbrA = nflAbbr(ev.sideA);
  const abbrB = nflAbbr(ev.sideB);
  if (!abbrA || !abbrB || abbrA === abbrB) return null;
  let pred;
  try {
    pred = await predictNfl(abbrA, abbrB);
  } catch (err) {
    console.warn('[nfl-pm] predict fail', ev.slug, err.message || err);
    return null;
  }
  const pA = Number(pred?.win_prob_a);
  if (!Number.isFinite(pA)) return null;
  const ratingA = Number(pred.elo_a);
  const ratingB = Number(pred.elo_b);
  const eloDiff = (Number.isFinite(ratingA) && Number.isFinite(ratingB))
    ? Math.abs(ratingA - ratingB)
    : 0;
  const strongProb = Math.max(pA, 1 - pA);
  const pickSide = pA >= 0.5 ? 'a' : 'b';
  const isHighConfidence = strongProb >= 0.75;
  const passList = isHighConfidence
    || eloDiff >= thr.eloDiffMin
    || strongProb >= thr.winProbMin;
  const tokens = ev.tokenIds || [];
  const pickTokenId = pickSide === 'a' ? (tokens[0] || null) : (tokens[1] || null);
  const pickName = pickSide === 'a' ? ev.sideA : ev.sideB;
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
    teamA: { id: abbrA, name: ev.sideA, rating: ratingA },
    teamB: { id: abbrB, name: ev.sideB, rating: ratingB },
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
    ...directionAlign(pickSide, ev.prices),
  };
}

function sortEloMatches(matches) {
  matches.sort((a, b) => {
    if (!!b.is_high_confidence !== !!a.is_high_confidence) {
      return b.is_high_confidence ? 1 : -1;
    }
    if (!!b.passList !== !!a.passList) {
      return b.passList ? 1 : -1;
    }
    const sa = a.startMs || Number.MAX_SAFE_INTEGER;
    const sb = b.startMs || Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return (b.eloDiff || 0) - (a.eloDiff || 0);
  });
  return matches;
}

/** NFL：Polymarket 采集后走 nflelo 过滤，并标记与盘口方向是否一致。 */
async function collectNfl() {
  if (nflBusy) return nflMemory;
  nflBusy = true;
  const thr = thresholds();
  try {
    const tag = (process.env.POLY_NFL_TAG_SLUG || 'nfl').trim() || 'nfl';
    const events = await fetchPolymarketEventsByTag(tag, null);
    const matches = [];
    for (const ev of events) {
      try {
        const row = await enrichNflEvent(ev, thr);
        if (row) matches.push(row);
      } catch (err) {
        console.warn('[nfl-pm] enrich skip', ev?.slug, err.message || err);
      }
    }
    sortEloMatches(matches);
    const bundle = {
      ok: true,
      sport: 'nfl',
      source: 'polymarket-gamma',
      fetched_at: new Date().toISOString(),
      thresholds: thr,
      matchCount: matches.length,
      edgeCount: matches.filter((m) => m.passList).length,
      hcCount: matches.filter((m) => m.is_high_confidence).length,
      scanned: events.length,
      matches,
    };
    nflMemory = bundle;
    const client = await redis.getClient();
    if (client) await client.set(NFL_BUNDLE_KEY, JSON.stringify(bundle));
    console.log(`[nfl-pm] collected ${matches.length}/${events.length}`);
    return bundle;
  } catch (err) {
    console.error('[nfl-pm] collect failed', err.message || err);
    if (nflMemory) return { ...nflMemory, ok: false, error: err.message || String(err) };
    return {
      ok: false,
      sport: 'nfl',
      source: 'polymarket-gamma',
      matches: [],
      matchCount: 0,
      scanned: 0,
      fetched_at: new Date().toISOString(),
      error: err.message || String(err),
    };
  } finally {
    nflBusy = false;
  }
}

async function readNflBundle() {
  const client = await redis.getClient();
  if (client) {
    try {
      const raw = await client.get(NFL_BUNDLE_KEY);
      if (raw) {
        nflMemory = JSON.parse(raw);
        return nflMemory;
      }
    } catch {
      /* memory */
    }
  }
  return nflMemory;
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
  collectDirect,
  collectNfl,
  readBundle,
  readNflBundle,
  getPlacedSet,
  markPlaced,
  startCollectLoop,
  placedKey,
};
