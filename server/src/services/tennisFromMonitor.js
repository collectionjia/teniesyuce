const tennisCache = require('./tennisCache');
const tennisLive = require('./tennisLive');
const tennisPolymarket = require('./tennisPolymarket');
const { enrichBundlePolymarket } = require('./tennisPolymarketMatch');

const MONITOR_BASE = (process.env.SOFA_MONITOR_URL || 'http://172.17.0.1:9004').replace(/\/$/, '');
const MONITOR_TOKEN = (process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026').trim();
const REFRESH_MS = Number(process.env.TENNIS_REDIS_REFRESH_MS || 60000);

let refreshPromise = null;
let lastRefreshAt = 0;
let timer = null;

async function monitorGet(pathname, timeoutMs = 15000) {
  const res = await fetch(`${MONITOR_BASE}${pathname}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${MONITOR_TOKEN}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`monitor ${pathname} HTTP ${res.status}`);
  return res.json();
}

function buildRankingsFromEvents(bundle) {
  const map = { ...(bundle.rankingsByPlayer || {}) };
  for (const t of bundle?.scheduled?.tournaments || []) {
    for (const ev of t.events || []) {
      for (const side of [ev.homePlayer, ev.awayPlayer]) {
        if (!side?.id) continue;
        const key = String(side.id);
        const rank = side.rank ?? side.ranking ?? side.currentRank;
        if (rank == null) continue;
        const prev = map[key] || {};
        map[key] = {
          current: prev.current ?? rank,
          previous: prev.previous ?? null,
          best: prev.best ?? rank,
          live: prev.live ?? rank,
          utr: prev.utr ?? null,
        };
      }
    }
  }
  for (const ev of bundle?.live?.matches || []) {
    for (const side of [ev.homePlayer, ev.awayPlayer]) {
      if (!side?.id) continue;
      const key = String(side.id);
      const rank = side.rank ?? side.ranking ?? side.currentRank;
      if (rank == null) continue;
      const prev = map[key] || {};
      map[key] = {
        current: prev.current ?? rank,
        previous: prev.previous ?? null,
        best: prev.best ?? rank,
        live: prev.live ?? rank,
        utr: prev.utr ?? null,
      };
    }
  }
  bundle.rankingsByPlayer = map;
}

function normalizeBundle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const scheduled = raw.scheduled || { tournaments: [], tournamentCount: 0, eventCount: 0 };
  const tournaments = scheduled.tournaments || [];
  const eventCount =
    scheduled.eventCount ??
    tournaments.reduce((n, t) => n + ((t.events || []).length), 0);

  const out = {
    sport: raw.sport || 'tennis',
    date: raw.date,
    serverTime: Math.floor(Date.now() / 1000),
    fetched_at: raw.fetched_at || new Date().toISOString(),
    source: 'sofascore-monitor',
    filter: raw.filter || raw.dataFilter || 'top20',
    top_rank_max: raw.top_rank_max ?? 20,
    exclude_ended: raw.exclude_ended !== false,
    update: raw.update || { message: 'from Sofascore monitor → Redis' },
    scheduled: {
      ...scheduled,
      tournaments,
      tournamentCount: scheduled.tournamentCount ?? tournaments.length,
      eventCount,
    },
    live: raw.live || { tournaments: [], tournamentCount: 0, eventCount: 0, matches: [] },
    rankingsByPlayer: raw.rankingsByPlayer || {},
    oddsByEvent: raw.oddsByEvent || {},
    eloByEvent: raw.eloByEvent || {},
    polymarketByEvent: raw.polymarketByEvent || {},
    theOddsApiByEvent: raw.theOddsApiByEvent || {},
    birthYearByPlayer: raw.birthYearByPlayer || {},
    ok: true,
    member: true,
    events: eventCount,
    message: `monitor→redis · ${eventCount} events`,
    bundle_file: raw.bundle_file || null,
  };
  buildRankingsFromEvents(out);
  return out;
}

/**
 * 从 Sofascore 监控拉取 daily_bundle + live，合并后写入 Redis。
 * 不写 MySQL。
 */
async function refreshRedisFromMonitor({ includeLive = true } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const body = await monitorGet('/bundle', 20000);
    if (!body?.ok && !body?.scheduled) {
      throw new Error(body?.error || 'monitor bundle unavailable');
    }
    let bundle = normalizeBundle(body);
    if (!bundle) throw new Error('invalid monitor bundle');

    if (includeLive) {
      try {
        let liveState = await tennisLive.fetchMonitorLiveOverlayState();
        // 快照不可靠（idle/过期/采集中）时强制拉一次，否则无法把完赛场次从「进行中」收口
        if (!liveState || !liveState.closeDropouts) {
          const events = await tennisLive.fetchMonitorLiveEventsFresh(true);
          liveState = { events: events || [], closeDropouts: true };
        }
        bundle = tennisLive.overlayBundleFromMonitor(bundle, liveState.events, {
          closeDropouts: liveState.closeDropouts,
        });
      } catch (e) {
        console.error('[tennis/monitor-redis] live overlay:', e.message);
      }
    }

    try {
      await enrichBundlePolymarket(bundle);
    } catch (e) {
      console.error('[tennis/monitor-redis] poly match:', e.message);
    }

    try {
      const polyStats = await tennisPolymarket.refreshPolymarketPrices(bundle);
      if (polyStats.updated || polyStats.failed) {
        console.log(
          `[tennis/monitor-redis] poly prices updated=${polyStats.updated} failed=${polyStats.failed}`,
        );
      }
    } catch (e) {
      console.error('[tennis/monitor-redis] poly refresh:', e.message);
    }

    bundle.serverTime = Math.floor(Date.now() / 1000);
    if (!bundle.live || typeof bundle.live !== 'object') {
      bundle.live = { tournaments: [], tournamentCount: 0, eventCount: 0, matches: [] };
    }
    bundle.live.eventCount = bundle.live.eventCount ?? (bundle.live.matches || []).length;
    await tennisCache.setCachedBundle(bundle, bundle.fetched_at);
    lastRefreshAt = Date.now();
    console.log(
      `[tennis/monitor-redis] cached date=${bundle.date} events=${bundle.events} live=${bundle.live?.eventCount || 0}`,
    );
    try {
      const tennisRangeFromMonitor = require('./tennisRangeFromMonitor');
      await tennisRangeFromMonitor.refreshRangeBundleFromMonitor();
    } catch (e) {
      console.error('[tennis/monitor-redis] range refresh:', e.message);
    }
    try {
      const tennisLiveFromMonitor = require('./tennisLiveFromMonitor');
      await tennisLiveFromMonitor.refreshLiveBundleFromMonitor();
    } catch (e) {
      console.error('[tennis/monitor-redis] live refresh:', e.message);
    }
    try {
      const tennisNewFromMonitor = require('./tennisNewFromMonitor');
      await tennisNewFromMonitor.refreshNewBundleFromMonitor();
    } catch (e) {
      console.error('[tennis/monitor-redis] new refresh:', e.message);
    }
    return bundle;
  })()
    .catch((e) => {
      console.error('[tennis/monitor-redis] refresh failed:', e.message);
      throw e;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

function kickRefreshBackground() {
  refreshRedisFromMonitor().catch(() => {});
}

function startBackgroundRefresh() {
  if (timer) return;
  timer = setInterval(() => {
    kickRefreshBackground();
  }, Math.max(15000, REFRESH_MS));
  // 启动后稍等再刷一次（给 redis/monitor 时间）
  setTimeout(() => kickRefreshBackground(), 3000);
}

module.exports = {
  refreshRedisFromMonitor,
  kickRefreshBackground,
  startBackgroundRefresh,
  normalizeBundle,
  buildRankingsFromEvents,
  get lastRefreshAt() {
    return lastRefreshAt;
  },
};
