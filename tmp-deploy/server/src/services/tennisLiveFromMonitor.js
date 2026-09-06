const tennisCache = require('./tennisCache');
const tennisLiveCache = require('./tennisLiveCache');
const tennisFromMonitor = require('./tennisFromMonitor');
const tennisLive = require('./tennisLive');
const { applyPolymarketLinks } = require('./tennisPolymarketMatch');
const {
  buildLiveBundle,
  allEventsFromBundle,
  groupEventsByTournament,
} = require('./tennisLiveFilter');
const tennisRangeFromMonitor = require('./tennisRangeFromMonitor');

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

async function fetchMonitorTop100Source() {
  return tennisRangeFromMonitor.fetchMonitorTop100Source();
}

function mergeEventsIntoBundle(base, extraEvents) {
  if (!base || !Array.isArray(extraEvents) || !extraEvents.length) return base;
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
  const { currentRankOf } = require('./tennisRangeFilter');
  const top100 = all.filter((m) => {
    const home = m.homePlayer || { name: m.home };
    const away = m.awayPlayer || { name: m.away };
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

async function fetchMonitorTop100Board() {
  try {
    return await monitorGet('/top100', 30000);
  } catch {
    return null;
  }
}

function eventsFromTop100Board(payload) {
  if (!payload || (!payload.atp && !payload.wta)) return { events: [], rankingsByPlayer: {} };
  const byId = new Map();
  const rankingsByPlayer = {};
  for (const tour of ['atp', 'wta']) {
    for (const p of payload[tour] || []) {
      const pid = p.id;
      if (pid != null) {
        rankingsByPlayer[String(pid)] = {
          current: p.rank,
          previous: p.previousRank ?? p.rank,
          best: p.bestRank ?? p.rank,
          live: p.rank,
        };
      }
      for (const m of p.matches || []) {
        if (m?.id == null) continue;
        const id = String(m.id);
        const playerName = String(p.name || '').trim();
        const home = m.home || playerName;
        const away = m.away || m.opponent;
        const homeIsPlayer = String(home).trim().toLowerCase() === playerName.toLowerCase();
        const ev = {
          id: m.id,
          home,
          away,
          homePlayer: homeIsPlayer
            ? { id: p.id, name: home, ranking: m.playerRank ?? p.rank }
            : { name: home, ranking: m.homeRank },
          awayPlayer: !homeIsPlayer
            ? { id: p.id, name: away, ranking: m.playerRank ?? p.rank }
            : { name: away, ranking: m.awayRank },
          status: m.status,
          statusType: m.statusRaw,
          startTime: m.startTime,
          url: m.url,
          slug: m.slug,
          customId: m.customId,
          tournament: m.tournament,
          roundLabel: m.round,
          tour: tour.toUpperCase(),
        };
        byId.set(id, byId.has(id) ? { ...byId.get(id), ...ev } : ev);
      }
    }
  }
  return { events: [...byId.values()], rankingsByPlayer };
}

async function refreshLiveBundleFromMonitor() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let base = await tennisCache.getBundle();
    if (!base) {
      base = await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
    }

    const top100Raw = await fetchMonitorTop100Source();
    const top100Board = await fetchMonitorTop100Board();
    const fromBoard = top100Board ? eventsFromTop100Board(top100Board) : { events: [], rankingsByPlayer: {} };

    if (top100Raw?.scheduled) {
      base = tennisFromMonitor.normalizeBundle(top100Raw);
    } else if (top100Raw?.events?.length) {
      base = mergeEventsIntoBundle(base, top100Raw.events);
    } else if (fromBoard.events.length) {
      base = mergeEventsIntoBundle(base, fromBoard.events);
      base.rankingsByPlayer = { ...(base.rankingsByPlayer || {}), ...fromBoard.rankingsByPlayer };
    } else {
      try {
        const liveEvents = await tennisLive.fetchMonitorLiveEventsFresh(false);
        if (liveEvents?.length) {
          base = mergeEventsIntoBundle(base, liveEvents);
        }
      } catch (e) {
        console.error('[tennis/live] live merge:', e.message);
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
        console.error('[tennis/live] live overlay:', e.message);
      }

      try {
        await applyPolymarketLinks(base);
      } catch (e) {
        console.error('[tennis/live] poly match:', e.message);
      }
    }

    const liveBundle = buildLiveBundle(base, { requirePoly: false });
    if (!liveBundle) throw new Error('failed to build live bundle');

    liveBundle.serverTime = Math.floor(Date.now() / 1000);
    liveBundle.fetched_at = liveBundle.fetched_at || new Date().toISOString();
    await tennisLiveCache.setCachedBundle(liveBundle, liveBundle.fetched_at);

    console.log(
      `[tennis/live] cached date=${liveBundle.date} live=${liveBundle.events}`,
    );
    return liveBundle;
  })()
    .catch((e) => {
      console.error('[tennis/live] refresh failed:', e.message);
      throw e;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

const LIVE_REFRESH_MS = Number(process.env.TENNIS_LIVE_REFRESH_MS || 120000);
let liveTimer = null;

function startBackgroundRefresh() {
  if (liveTimer) return;
  liveTimer = setInterval(() => {
    refreshLiveBundleFromMonitor().catch((e) => {
      console.error('[tennis/live] bg refresh:', e.message);
    });
  }, Math.max(60000, LIVE_REFRESH_MS));
}

module.exports = {
  refreshLiveBundleFromMonitor,
  startBackgroundRefresh,
};
