const tennisInplayCache = require('./tennisInplayCache');
const tennisPrematchCache = require('./tennisPrematchCache');
const tennisSettledCache = require('./tennisSettledCache');
const { isLiveStatusRaw, isEndedStatus } = require('./tennisLive');

const BUCKET_SOURCES = [
  { bucket: 'inplay', getBundle: () => tennisInplayCache.getBundle() },
  { bucket: 'prematch', getBundle: () => tennisPrematchCache.getBundle() },
  { bucket: 'settled', getBundle: () => tennisSettledCache.getBundle() },
];

function eventStartSec(event) {
  const ts = Number(event?.startTimestamp);
  return Number.isFinite(ts) ? Math.floor(ts) : null;
}

/** 当前时间是否已过开赛时间 */
function isPastStartTime(event, nowSec = Math.floor(Date.now() / 1000)) {
  const ts = eventStartSec(event);
  if (ts == null) return false;
  return nowSec >= ts;
}

/** 是否真正「比赛中」（进行中，非已结束/未开赛） */
function resolveInPlay(event) {
  if (isEndedStatus(event?.status, event?.statusType)) return false;
  const st = String(event?.statusType || '').toLowerCase();
  if (st === 'notstarted' || st === 'postponed' || st === 'cancelled' || st === 'canceled') {
    return false;
  }
  return isLiveStatusRaw(event?.status, event?.statusType);
}

function findEventInBundle(bundle, eventId) {
  const id = String(eventId || '').trim();
  if (!id || !bundle) return null;
  const liveMatches = Array.isArray(bundle.live?.matches) ? bundle.live.matches : [];
  const fromLive = liveMatches.find((m) => String(m?.id) === id);
  if (fromLive) return fromLive;
  for (const t of bundle.scheduled?.tournaments || []) {
    for (const ev of t.events || []) {
      if (String(ev?.id) === id) return ev;
    }
  }
  return null;
}

function playerIdsFromEvent(event) {
  const ids = [];
  const push = (p) => {
    const pid = p?.id ?? p?.playerId;
    if (pid != null && pid !== '') ids.push(String(pid));
  };
  push(event?.homePlayer);
  push(event?.awayPlayer);
  return ids;
}

function pickDictByKeys(dict, keys) {
  const out = {};
  if (!dict || typeof dict !== 'object') return out;
  for (const key of keys) {
    if (dict[key] != null) out[key] = dict[key];
  }
  return out;
}

/**
 * 跨 inplay / prematch / settled 查找单场；开赛时间已过即可命中。
 * @returns {Promise<null|{ bucket, bundle, event, pastStart, inPlay, serverTime }>}
 */
async function lookupMatchByEventId(eventId) {
  const id = String(eventId || '').trim();
  if (!id) return null;
  const serverTime = Math.floor(Date.now() / 1000);

  for (const { bucket, getBundle } of BUCKET_SOURCES) {
    const bundle = await getBundle();
    const raw = findEventInBundle(bundle, id);
    if (!raw) continue;

    const poly = bundle?.polymarketByEvent?.[String(raw.id)]
      || bundle?.polymarketByEvent?.[raw.id]
      || null;
    const event = enrichEvent(raw, serverTime, poly);
    if (!event.pastStart && !event.inPlay && !event.pmSettled) continue;
    return {
      bucket,
      bundle,
      event,
      pastStart: event.pastStart,
      inPlay: event.inPlay,
      serverTime,
    };
  }
  return null;
}

function buildPublicMatchPayload(row) {
  const { bundle, event, bucket, pastStart, inPlay, serverTime } = row;
  const eid = String(event.id);
  const playerIds = playerIdsFromEvent(event);
  const sourceMap = {
    inplay: 'tennis-collect-live',
    prematch: 'redis-prematch',
    settled: 'redis-settled',
  };

  return {
    ok: true,
    found: true,
    sport: 'tennis',
    product: 'tennis-inplay',
    eventId: eid,
    bucket,
    pastStart,
    inPlay,
    date: bundle.date,
    fetched_at: bundle.fetched_at,
    source: bundle.source || sourceMap[bucket] || bucket,
    dataSource: bundle.dataSource || bundle.collectScript || bucket,
    serverTime,
    event,
    rankingsByPlayer: pickDictByKeys(bundle.rankingsByPlayer, playerIds),
    oddsByEvent: bundle.oddsByEvent?.[eid] ? { [eid]: bundle.oddsByEvent[eid] } : {},
    polymarketByEvent: bundle.polymarketByEvent?.[eid] ? { [eid]: bundle.polymarketByEvent[eid] } : {},
    eloByEvent: bundle.eloByEvent?.[eid] ? { [eid]: bundle.eloByEvent[eid] } : {},
    theOddsApiByEvent: bundle.theOddsApiByEvent?.[eid] ? { [eid]: bundle.theOddsApiByEvent[eid] } : {},
    birthYearByPlayer: pickDictByKeys(bundle.birthYearByPlayer, playerIds),
    odds: bundle.oddsByEvent?.[eid] || null,
    polymarket: bundle.polymarketByEvent?.[eid] || null,
  };
}

function iterBundleEvents(bundle) {
  if (!bundle) return [];
  const out = [];
  for (const m of bundle.live?.matches || []) out.push(m);
  for (const t of bundle.scheduled?.tournaments || []) {
    for (const ev of t.events || []) out.push(ev);
  }
  return out;
}

/** 价格归一到 0–1；>1.5 视为美分 */
function priceToUnit(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1.5 ? n / 100 : n;
}

function polySidePrices(poly) {
  if (!poly || typeof poly !== 'object') return { home: null, away: null };
  let home = priceToUnit(poly.home_price);
  let away = priceToUnit(poly.away_price);
  const objPrices = [poly.prices, poly.moneyline?.prices];
  for (const p of objPrices) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    if (home == null) home = priceToUnit(p.home);
    if (away == null) away = priceToUnit(p.away);
  }
  return { home, away };
}

/** 一侧 ≥ 0.995（≈100¢）视为已结算，价高的一侧获胜 */
function applyPmSettle(event, poly) {
  const { home, away } = polySidePrices(poly);
  const TH = 0.995;
  let winner = null;
  if (home != null && home >= TH && (away == null || home >= away)) winner = 'home';
  else if (away != null && away >= TH) winner = 'away';
  if (!winner) return event;
  const homeName = event.homePlayer?.name || event.home || '';
  const awayName = event.awayPlayer?.name || event.away || '';
  return {
    ...event,
    winner,
    winnerName: winner === 'home' ? homeName : awayName,
    pmSettled: true,
    inPlay: false,
    statusType: 'finished',
    status: 'Ended',
    pmHomePrice: home,
    pmAwayPrice: away,
  };
}

function enrichEvent(event, serverTime = Math.floor(Date.now() / 1000), poly = null) {
  const pastStart = isPastStartTime(event, serverTime);
  let inPlay = resolveInPlay(event);
  let out = { ...event, pastStart, inPlay };
  if (poly) out = applyPmSettle(out, poly);
  if (out.pmSettled) {
    out.inPlay = false;
    out.statusType = 'finished';
    out.status = out.status && String(out.status).toLowerCase() !== 'not started' ? out.status : 'Ended';
    if (!/ended|finished/i.test(String(out.status || ''))) out.status = 'Ended';
  }
  return out;
}

/** 开赛已过或真正进行中的场次；inplay 桶优先 */
async function listInplayEligibleEvents() {
  const serverTime = Math.floor(Date.now() / 1000);
  const byId = new Map();
  const buckets = [
    { priority: 0, bundle: await tennisInplayCache.getBundle() },
    { priority: 1, bundle: await tennisPrematchCache.getBundle() },
    { priority: 2, bundle: await tennisSettledCache.getBundle() },
  ];
  for (const { priority, bundle } of buckets) {
    for (const raw of iterBundleEvents(bundle)) {
      const poly = bundle?.polymarketByEvent?.[String(raw.id)]
        || bundle?.polymarketByEvent?.[raw.id]
        || null;
      const row = enrichEvent(raw, serverTime, poly);
      if (!row.pastStart && !row.inPlay && !row.pmSettled) continue;
      const id = String(raw.id);
      const prev = byId.get(id);
      if (!prev || priority < prev.priority) {
        byId.set(id, { ...row, priority });
      }
    }
  }
  return {
    serverTime,
    events: [...byId.values()].map(({ priority, ...ev }) => ev),
  };
}

module.exports = {
  eventStartSec,
  isPastStartTime,
  resolveInPlay,
  findEventInBundle,
  iterBundleEvents,
  enrichEvent,
  applyPmSettle,
  lookupMatchByEventId,
  buildPublicMatchPayload,
  listInplayEligibleEvents,
  playerIdsFromEvent,
  pickDictByKeys,
};
