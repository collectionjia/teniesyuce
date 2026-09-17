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

    const pastStart = isPastStartTime(raw, serverTime);
    const inPlay = resolveInPlay(raw);
    if (!pastStart && !inPlay) continue;

    const event = {
      ...raw,
      inPlay,
      pastStart,
    };
    return {
      bucket,
      bundle,
      event,
      pastStart,
      inPlay,
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

function enrichEvent(event, serverTime = Math.floor(Date.now() / 1000)) {
  const pastStart = isPastStartTime(event, serverTime);
  const inPlay = resolveInPlay(event);
  return { ...event, pastStart, inPlay };
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
      const row = enrichEvent(raw, serverTime);
      if (!row.pastStart && !row.inPlay) continue;
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
  lookupMatchByEventId,
  buildPublicMatchPayload,
  listInplayEligibleEvents,
  playerIdsFromEvent,
  pickDictByKeys,
};
