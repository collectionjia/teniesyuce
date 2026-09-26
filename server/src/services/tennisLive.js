const MONITOR_BASE = (process.env.SOFA_MONITOR_URL || 'http://172.17.0.1:9004').replace(/\/$/, '');
const MONITOR_TOKEN = (process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026').trim();
const SYNC_MIN_INTERVAL_MS = Number(process.env.TENNIS_LIVE_SYNC_MS || 50000);

let lastSyncAt = 0;
let syncPromise = null;

function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

function matchKey(home, away) {
  return `${normName(home)}|${normName(away)}`;
}

function isEndedStatus(status, statusType) {
  const t = String(status || '').toLowerCase();
  const st = String(statusType || '').toLowerCase();
  return (
    t === 'ended' ||
    t === 'finished' ||
    t === 'closed' ||
    t === 'walkover' ||
    st === 'finished' ||
    st === 'ended'
  );
}

function isLiveStatusRaw(status, statusType) {
  const st = String(statusType || '').toLowerCase();
  if (st === 'inprogress' || st === 'live' || st === 'interrupted') return true;
  const t = String(status || '').toLowerCase();
  return (
    t.includes('live') ||
    t === 'inprogress' ||
    t === 'started' ||
    t.includes('1st') ||
    t.includes('2nd') ||
    t.includes('3rd') ||
    t.includes('set') ||
    t.includes('进行') ||
    t.includes('interrupt')
  );
}

function scoreVal(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    const cur = v.current ?? v.display ?? v.score;
    if (cur == null || cur === '') return null;
    const n = Number(cur);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iterServiceEvents(payload) {
  const out = [];
  for (const m of payload?.live?.matches || []) out.push(m);
  for (const t of payload?.scheduled?.tournaments || []) {
    for (const e of t.events || []) out.push(e);
  }
  return out;
}

function buildServiceIndex(payload) {
  const byId = new Map();
  const byNames = new Map();
  const liveKeys = new Set();
  for (const m of payload?.live?.matches || []) {
    liveKeys.add(matchKey(m.home || m.homePlayer?.name, m.away || m.awayPlayer?.name));
    if (m.id != null) byId.set(String(m.id), m);
    byNames.set(matchKey(m.home || m.homePlayer?.name, m.away || m.awayPlayer?.name), m);
  }
  for (const e of iterServiceEvents(payload)) {
    if (e.id != null) byId.set(String(e.id), e);
    byNames.set(matchKey(e.home || e.homePlayer?.name, e.away || e.awayPlayer?.name), e);
  }
  return { byId, byNames, liveKeys };
}

function pickServiceEvent(event, index) {
  const hit =
    index.byId.get(String(event.id)) ||
    index.byNames.get(matchKey(event.home, event.away));
  return hit || null;
}

function buildScoreText(source) {
  if (source.scoreText) return source.scoreText;
  if (source.score_text) return source.score_text;
  if (typeof source.score === 'string' && source.score.includes('-')) {
    return source.score.replace(/,\s*/g, ' ');
  }
  const hs = source.homeScore ?? source.home_score;
  const as = source.awayScore ?? source.away_score;
  if (hs && typeof hs === 'object' && as && typeof as === 'object') {
    const parts = [];
    for (const key of ['period1', 'period2', 'period3', 'period4', 'period5']) {
      if (hs[key] != null && as[key] != null) parts.push(`${hs[key]}-${as[key]}`);
    }
    if (parts.length) return parts.join(' ');
  }
  return null;
}

function applyServiceEvent(target, source) {
  if (!source) return target;
  const next = { ...target };
  if (source.status != null) next.status = source.status;
  if (source.statusType != null) next.statusType = source.statusType;
  const scoreText = buildScoreText(source);
  if (scoreText) next.scoreText = scoreText;
  const hs = source.homeScore ?? source.home_score;
  const as = source.awayScore ?? source.away_score;
  if (hs != null && typeof hs === 'object') next.homeScore = hs;
  else {
    const hvn = scoreVal(hs);
    if (hvn != null) next.homeScore = hvn;
  }
  if (as != null && typeof as === 'object') next.awayScore = as;
  else {
    const avn = scoreVal(as);
    if (avn != null) next.awayScore = avn;
  }
  // 有 period 时 home_score 保持 null，避免被写成盘数 0
  const hasPeriods = (obj) => obj && typeof obj === 'object'
    && ['period1', 'period2', 'period3', 'period4', 'period5'].some((k) => obj[k] != null);
  if (hasPeriods(next.homeScore)) next.home_score = null;
  else if (next.homeScore != null) next.home_score = next.homeScore;
  if (hasPeriods(next.awayScore)) next.away_score = null;
  else if (next.awayScore != null) next.away_score = next.awayScore;
  return next;
}

/** 离开 live 列表后标记完赛（保留最后比分，前端不再按进行中展示） */
function markMatchEnded(target) {
  if (!target || isEndedStatus(target.status, target.statusType)) return target;
  return {
    ...target,
    status: 'Ended',
    statusType: 'finished',
  };
}

function eventInLiveFeed(event, liveIds, liveNameKeys) {
  if (!event) return false;
  if (event.id != null && liveIds.has(String(event.id))) return true;
  return liveNameKeys.has(
    matchKey(event.home || event.homePlayer?.name, event.away || event.awayPlayer?.name),
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function monitorEventsFromSnapshot(body) {
  return body?.last?.events || body?.events || [];
}

function isMonitorSnapshotStale(body) {
  const last = body?.last;
  if (!last) return true;
  if (last.status === 'running') return false;
  const fetched = last.fetched_at;
  if (!fetched) return true;
  const ts = Date.parse(String(fetched).replace(' UTC', 'Z'));
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > 3 * 60 * 1000;
}

function monitorPayloadFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  return {
    live: { matches: list },
    scheduled: { tournaments: [{ events: list }] },
  };
}

async function fetchMonitorLiveSnapshot(timeoutMs = 10000) {
  try {
    const res = await fetch(`${MONITOR_BASE}/live`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${MONITOR_TOKEN}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    console.error('[tennis/monitor-live]', e.message);
    return null;
  }
}

async function triggerMonitorLiveCollect() {
  try {
    await fetch(`${MONITOR_BASE}/live/collect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[tennis/monitor-collect]', e.message);
  }
}

/** 拉取 Sofascore 监控进行中比分；syncLive 时触发刷新并等待最新数据 */
async function fetchMonitorLiveEventsFresh(forceCollect = false) {
  let snap = await fetchMonitorLiveSnapshot(10000);
  const stale = !snap || isMonitorSnapshotStale(snap);
  if (forceCollect || stale) {
    if (snap?.last?.status !== 'running') {
      await triggerMonitorLiveCollect();
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(2000);
      snap = await fetchMonitorLiveSnapshot(10000);
      const last = snap?.last;
      if (last?.status === 'success' && Array.isArray(last.events) && last.events.length) {
        break;
      }
      if (last?.status === 'failed') break;
    }
  }
  return monitorEventsFromSnapshot(snap);
}

/** 列表热路径：只读当前快照，短超时，不等待采集 */
async function fetchMonitorLiveEvents() {
  const snap = await fetchMonitorLiveSnapshot(2000);
  return monitorEventsFromSnapshot(snap);
}

/**
 * 可靠 live 快照（区分「当前确实 0 场进行中」与「拉取失败」）。
 * closeDropouts=true 时才可把不在 live 列表里的场次标为完赛。
 */
async function fetchMonitorLiveOverlayState() {
  const snap = await fetchMonitorLiveSnapshot(2000);
  if (!snap) return null;
  const last = snap.last;
  if (last?.status === 'failed') return null;
  if (last?.status === 'running') {
    return {
      events: monitorEventsFromSnapshot(snap) || [],
      closeDropouts: false,
    };
  }
  if (isMonitorSnapshotStale(snap)) {
    return {
      events: monitorEventsFromSnapshot(snap) || [],
      closeDropouts: false,
    };
  }
  return {
    events: monitorEventsFromSnapshot(snap) || [],
    closeDropouts: true,
  };
}

/** 将 Sofascore 监控采集的进行中比分合并进 bundle；允许空列表（用于完赛收口） */
function overlayBundleFromMonitor(bundle, monitorEvents, { closeDropouts = true } = {}) {
  if (!bundle) return bundle;
  return overlayBundleFromService(
    bundle,
    monitorPayloadFromEvents(monitorEvents),
    { closeDropouts },
  );
}

/** 将 live 数据合并进 bundle（按 id / 对阵名匹配）；监控有、赛程包没有的进行中场次一并挂上 */
function overlayBundleFromService(bundle, payload, { closeDropouts = true } = {}) {
  if (!bundle || !payload) return bundle;
  const index = buildServiceIndex(payload);
  const liveIds = new Set();
  const liveNameKeys = new Set();
  for (const m of payload?.live?.matches || []) {
    if (m?.id != null) liveIds.add(String(m.id));
    liveNameKeys.add(matchKey(m.home || m.homePlayer?.name, m.away || m.awayPlayer?.name));
  }

  const tournaments = (bundle.scheduled?.tournaments || []).map((t) => ({
    ...t,
    events: (t.events || []).map((e) => {
      let next = applyServiceEvent(e, pickServiceEvent(e, index));
      if (isEndedStatus(next.status, next.statusType)) return next;
      // 可靠快照下：曾显示进行中、但已不在 live 列表 → 完赛
      if (
        closeDropouts
        && !eventInLiveFeed(next, liveIds, liveNameKeys)
        && isLiveStatusRaw(next.status, next.statusType)
      ) {
        next = markMatchEnded(next);
      }
      return next;
    }),
  }));

  const liveMatches = [];
  const seen = new Set();
  for (const t of tournaments) {
    for (const e of t.events || []) {
      if (isLiveStatusRaw(e.status, e.statusType) && !isEndedStatus(e.status, e.statusType)) {
        liveMatches.push(e);
        if (e.id != null) seen.add(String(e.id));
      }
    }
  }

  // Top20 赛程包外的进行中场次（监控 live 全量）也要展示
  for (const e of iterServiceEvents(payload)) {
    if (!e || e.id == null) continue;
    const id = String(e.id);
    if (seen.has(id)) continue;
    if (!isLiveStatusRaw(e.status, e.statusType) || isEndedStatus(e.status, e.statusType)) continue;
    liveMatches.push({
      ...e,
      home: e.home || e.homePlayer?.name,
      away: e.away || e.awayPlayer?.name,
      homePlayer: e.homePlayer || { name: e.home },
      awayPlayer: e.awayPlayer || { name: e.away },
      tournament: e.tournament || e.tournamentShort || null,
      tournamentShort: e.tournamentShort || e.tournament || null,
      level: e.level || null,
      tour: e.tour || null,
      gender: e.gender || e.homePlayer?.gender || e.awayPlayer?.gender || null,
    });
    seen.add(id);
  }

  return {
    ...bundle,
    scheduled: {
      ...bundle.scheduled,
      tournaments,
    },
    live: {
      tournaments: [],
      tournamentCount: 0,
      eventCount: liveMatches.length,
      matches: liveMatches,
    },
    liveSyncAt: new Date().toISOString(),
  };
}

/**
 * 后台从 Sofascore 监控刷新 Redis（不写 MySQL）。
 */
async function doSyncLive() {
  const tennisFromMonitor = require('./tennisFromMonitor');
  return tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
}

/** 限流后台同步；多用户并发共用同一个 syncPromise */
async function syncLiveIfNeeded(_force = false) {
  if (syncPromise) return syncPromise;
  const now = Date.now();
  if (now - lastSyncAt < SYNC_MIN_INTERVAL_MS) {
    return null;
  }
  syncPromise = doSyncLive()
    .catch((e) => {
      console.error('[tennis/live-sync]', e.message);
      return null;
    })
    .finally(() => {
      syncPromise = null;
      lastSyncAt = Date.now();
    });
  return syncPromise;
}

/** 不阻塞：触发后台从监控刷新 Redis */
function kickSyncLiveBackground() {
  syncLiveIfNeeded(true).catch((e) => {
    console.error('[tennis/live-sync-bg]', e.message);
  });
}

module.exports = {
  buildScoreText,
  applyServiceEvent,
  isEndedStatus,
  isLiveStatusRaw,
  fetchMonitorLiveEvents,
  fetchMonitorLiveEventsFresh,
  fetchMonitorLiveOverlayState,
  overlayBundleFromService,
  overlayBundleFromMonitor,
  syncLiveIfNeeded,
  kickSyncLiveBackground,
};
