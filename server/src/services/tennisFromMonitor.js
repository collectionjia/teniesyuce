const tennisCache = require('./tennisCache');
const tennisLive = require('./tennisLive');
const { applyPolymarketLinks } = require('./tennisPolymarketMatch');
const allsports = require('./allsports');
const tennisDataSource = require('./tennisDataSource');

const MONITOR_BASE = (process.env.SOFA_MONITOR_URL || 'http://172.17.0.1:9004').replace(/\/$/, '');
const MONITOR_TOKEN = (process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026').trim();
const REFRESH_MS = Number(process.env.TENNIS_REDIS_REFRESH_MS || 60000);

let refreshPromise = null;
let lastRefreshAt = 0;
let timer = null;
let lastRedisRefresh = {};

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
  const applySide = (side) => {
    if (!side?.id) return;
    const key = String(side.id);
    const rank = side.rank ?? side.ranking ?? side.currentRank;
    const prev = map[key] || {};
    // 禁止用现排名冒充历史最高 / live
    map[key] = {
      current: prev.current ?? rank ?? null,
      previous: prev.previous ?? side.previousRank ?? null,
      best: prev.best ?? side.bestRank ?? side.best ?? null,
      live: prev.live ?? side.liveRank ?? null,
      utr: prev.utr ?? side.utr ?? null,
    };
  };
  for (const t of bundle?.scheduled?.tournaments || []) {
    for (const ev of t.events || []) {
      applySide(ev.homePlayer);
      applySide(ev.awayPlayer);
      // 场次上已挂载的 rankings 优先保留 best
      const byPlayer = ev.rankings || {};
      for (const [pid, row] of Object.entries(byPlayer)) {
        if (!row || typeof row !== 'object') continue;
        const prev = map[pid] || {};
        map[pid] = {
          current: prev.current ?? row.current ?? null,
          previous: prev.previous ?? row.previous ?? null,
          best: prev.best ?? row.best ?? null,
          live: prev.live ?? row.live ?? null,
          utr: prev.utr ?? row.utr ?? null,
        };
      }
    }
  }
  for (const ev of bundle?.live?.matches || []) {
    applySide(ev.homePlayer);
    applySide(ev.awayPlayer);
    const byPlayer = ev.rankings || {};
    for (const [pid, row] of Object.entries(byPlayer)) {
      if (!row || typeof row !== 'object') continue;
      const prev = map[pid] || {};
      map[pid] = {
        current: prev.current ?? row.current ?? null,
        previous: prev.previous ?? row.previous ?? null,
        best: prev.best ?? row.best ?? null,
        live: prev.live ?? row.live ?? null,
        utr: prev.utr ?? row.utr ?? null,
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
    source: raw.source || 'tennis-monitor',
    upstream: raw.upstream || raw.source || null,
    dataSource: raw.dataSource || raw.upstream || null,
    filter: raw.filter || raw.dataFilter || 'top20',
    top_rank_max: raw.top_rank_max ?? 20,
    exclude_ended: raw.exclude_ended !== false,
    update: raw.update || { message: '采集写入 Redis' },
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
    requests: raw.requests || null,
    polyMatch: raw.polyMatch || null,
    redisRefresh: raw.redisRefresh || null,
    virtualSim: raw.virtualSim || null,
    ok: true,
    member: true,
    events: eventCount,
    message: raw.message || `monitor→redis · ${eventCount} events`,
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
    const redisStarted = Date.now();
    const pref = await tennisDataSource.get();
    const useAllsports = pref === 'api';
    const useDocks500 = pref === 'docks500';
    let bundle;
    if (useDocks500) {
      const tennisDocks500 = require('./tennisDocks500');
      const raw = await tennisDocks500.loadSelectedBundle();
      bundle = normalizeBundle(raw);
      if (!bundle) throw new Error('invalid docks500 bundle');
    } else if (useAllsports) {
      if (!allsports.isConfigured()) {
        throw new Error('已选择 AllSports API，但未配置 RAPIDAPI_KEY');
      }
      const raw = await allsports.loadTodayBundle();
      bundle = normalizeBundle(raw);
      if (!bundle) throw new Error('invalid allsports bundle');
    } else {
      const body = await monitorGet('/bundle', 20000);
      if (!body?.ok && !body?.scheduled) {
        throw new Error(body?.error || 'monitor bundle unavailable');
      }
      bundle = normalizeBundle(body);
    }
    if (!bundle) throw new Error('invalid monitor bundle');

    bundle.dataSource = pref;
    bundle.upstream = useDocks500 ? 'docks500' : useAllsports ? 'allsportsapi2' : 'ipwo';
    bundle.source = bundle.upstream;
    if (useAllsports && !(Number(bundle.events) > 0)) {
      const existing = await tennisCache.getBundle();
      if (existing && Number(existing.events) > 0) {
        console.warn('[tennis/allsports-redis] empty refresh, keep previous redis bundle');
        return existing;
      }
    }
    if (includeLive && !useAllsports && !useDocks500) {
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

    let polyStats = null;
    if (!useDocks500) {
      try {
        polyStats = await applyPolymarketLinks(bundle);
        bundle.polyMatch = polyStats;
        if (polyStats.fromGamma || polyStats.fromMysql || polyStats.prices?.updated) {
          console.log(
            `[tennis/monitor-redis] poly linked=${polyStats.matched} gamma=${polyStats.fromGamma} ` +
              `prices=${polyStats.prices?.updated || 0} ms=${polyStats.timingMs?.total || 0}`,
          );
        }
      } catch (e) {
        console.error('[tennis/monitor-redis] poly match:', e.message);
      }
    }

    const redisRefreshMs = Date.now() - redisStarted;
    bundle.redisRefresh = {
      totalMs: redisRefreshMs,
      polyMs: polyStats?.timingMs?.total || 0,
      polyMatchMs: polyStats?.timingMs?.match || 0,
      polyPriceMs: polyStats?.timingMs?.prices || 0,
      at: new Date().toISOString(),
    };
    lastRedisRefresh = {
      requests: bundle.requests || null,
      poly: polyStats,
      redisRefresh: bundle.redisRefresh,
      upstream: bundle.upstream,
      events: bundle.events,
      at: bundle.fetched_at,
    };

    bundle.serverTime = Math.floor(Date.now() / 1000);
    if (!bundle.live || typeof bundle.live !== 'object') {
      bundle.live = { tournaments: [], tournamentCount: 0, eventCount: 0, matches: [] };
    }
    bundle.live.eventCount = bundle.live.eventCount ?? (bundle.live.matches || []).length;
    await tennisCache.setCachedBundle(bundle, bundle.fetched_at);
    if (useDocks500) {
      try {
        const tennisThreeBuckets = require('./tennisThreeBuckets');
        const split = await tennisThreeBuckets.splitFullToThreeBuckets(bundle);
        bundle.bucketSplit = split;
        bundle.virtualSim = bundle.virtualSim || null;
        console.log(
          `[tennis/monitor-redis] docks500 buckets prematch=${split.prematch} inplay=${split.inplay} settled=${split.settled}`,
        );
      } catch (e) {
        console.error('[tennis/monitor-redis] docks500 three-buckets:', e.message);
        try {
          const tennisSettledCache = require('./tennisSettledCache');
          await tennisSettledCache.setCachedBundle(bundle, bundle.fetched_at);
        } catch (e2) {
          console.error('[tennis/monitor-redis] docks500 settled write:', e2.message);
        }
      }
    }
    lastRefreshAt = Date.now();
    console.log(
      `[tennis/monitor-redis] cached upstream=${bundle.upstream} date=${bundle.date} events=${bundle.events} live=${bundle.live?.eventCount || 0}`,
    );
    if (!useDocks500) {
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
  getLastRedisRefresh() {
    return { ...lastRedisRefresh };
  },
};
