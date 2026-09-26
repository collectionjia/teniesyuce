const tennisCache = require('./tennisCache');
const tennisRangeCache = require('./tennisRangeCache');
const tennisFromMonitor = require('./tennisFromMonitor');
const tennisLive = require('./tennisLive');
const {
  buildRangeBundle,
  allEventsFromBundle,
  groupEventsByTournament,
} = require('./tennisRangeFilter');

const MONITOR_BASE = (process.env.SOFA_MONITOR_URL || 'http://172.17.0.1:9004').replace(/\/$/, '');
const MONITOR_TOKEN = (process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026').trim();

let refreshPromise = null;

async function monitorGet(pathname, timeoutMs = 20000) {
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

/** 尝试从监控拉 Top100 全量赛程（需监控 patch /events/today 或 /bundle/top100） */
async function fetchMonitorTop100Source() {
  const paths = ['/bundle/top100', '/bundle?filter=top100', '/events/today'];
  for (const p of paths) {
    try {
      const body = await monitorGet(p, 25000);
      if (body?.scheduled || body?.events?.length) return body;
    } catch {
      /* try next */
    }
  }
  return null;
}

function mergeEventsIntoBundle(base, extraEvents) {
  if (!base || !Array.isArray(extraEvents) || !extraEvents.length) return base;
  const rankings = base.rankingsByPlayer || {};
  const byId = new Map();
  for (const m of allEventsFromBundle(base)) {
    if (m?.id != null) byId.set(String(m.id), m);
  }
  for (const e of extraEvents) {
    if (e?.id == null) continue;
    const id = String(e.id);
    byId.set(id, byId.has(id) ? { ...byId.get(id), ...e } : e);
  }
  const merged = [...byId.values()];
  const scheduled = groupEventsByTournament(merged);
  return {
    ...base,
    scheduled,
    events: merged.length,
    top_rank_max: 100,
    filter: base.filter || 'top100-merge',
  };
}

function filterTop100EitherSide(bundle) {
  const rankings = bundle?.rankingsByPlayer || {};
  const all = allEventsFromBundle(bundle);
  const top100 = all.filter((m) => {
    const home = m.homePlayer || { name: m.home };
    const away = m.awayPlayer || { name: m.away };
    const { currentRankOf } = require('./tennisRangeFilter');
    const homeR = currentRankOf(home, rankings);
    const awayR = currentRankOf(away, rankings);
    return (homeR != null && homeR <= 100) || (awayR != null && awayR <= 100);
  });
  const scheduled = groupEventsByTournament(top100);
  return {
    ...bundle,
    scheduled,
    filter: 'top100',
    top_rank_max: 100,
    events: top100.length,
  };
}

/**
 * 构建区间网球 Redis 包：
 * 1. 优先监控 Top100 全量赛程
 * 2. 否则合并主包 + live 全量事件
 * 3. 筛任一方 Top100，再应用区间现差规则
 */
async function refreshRangeBundleFromMonitor() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let base = await tennisCache.getBundle();
    if (!base) {
      base = await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
    }

    const top100Raw = await fetchMonitorTop100Source();
    if (top100Raw?.scheduled) {
      base = tennisFromMonitor.normalizeBundle(top100Raw);
    } else if (top100Raw?.events?.length) {
      base = mergeEventsIntoBundle(base, top100Raw.events);
    } else {
      try {
        const liveEvents = await tennisLive.fetchMonitorLiveEventsFresh(false);
        if (liveEvents?.length) {
          base = mergeEventsIntoBundle(base, liveEvents);
        }
      } catch (e) {
        console.error('[tennis/range] live merge:', e.message);
      }
      base = filterTop100EitherSide(base);
    }

    if (base) {
      try {
        let liveState = await tennisLive.fetchMonitorLiveOverlayState();
        if (!liveState || !liveState.closeDropouts) {
          const events = await tennisLive.fetchMonitorLiveEventsFresh(true);
          liveState = { events: events || [], closeDropouts: true };
        }
        base = tennisLive.overlayBundleFromMonitor(base, liveState.events, {
          closeDropouts: liveState.closeDropouts,
        });
      } catch (e) {
        console.error('[tennis/range] live overlay:', e.message);
      }

    }

    const rangeBundle = buildRangeBundle(base, { requirePoly: false });
    if (!rangeBundle) throw new Error('failed to build range bundle');

    rangeBundle.serverTime = Math.floor(Date.now() / 1000);
    rangeBundle.fetched_at = rangeBundle.fetched_at || new Date().toISOString();
    await tennisRangeCache.setCachedBundle(rangeBundle, rangeBundle.fetched_at);

    const totalTop100 = allEventsFromBundle(base).filter((m) => {
      const { passesTop100Pool } = require('./tennisRangeFilter');
      return passesTop100Pool(m, base.rankingsByPlayer || {});
    }).length;
    console.log(
      `[tennis/range] cached date=${rangeBundle.date} range=${rangeBundle.events} top100_pool=${totalTop100}`,
    );
    return rangeBundle;
  })()
    .catch((e) => {
      console.error('[tennis/range] refresh failed:', e.message);
      throw e;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

module.exports = {
  refreshRangeBundleFromMonitor,
  fetchMonitorTop100Source,
  mergeEventsIntoBundle,
};
