const tennisCache = require('./tennisCache');
const tennisNewCache = require('./tennisNewCache');
const tennisFromMonitor = require('./tennisFromMonitor');
const tennisLive = require('./tennisLive');
const {
  buildNewBundle,
  allEventsFromBundle,
  groupEventsByTournament,
  passesTopPool,
  NEW_TOP_RANK_MAX,
} = require('./tennisRangeFilter');
const { fetchMonitorTop100Source, mergeEventsIntoBundle } = require('./tennisRangeFromMonitor');

let refreshPromise = null;

function mergeTop100BoardRankings(bundle) {
  if (!bundle) return bundle;
  const map = { ...(bundle.rankingsByPlayer || {}) };
  const board = bundle.top100 || {};
  for (const tour of ['atp', 'wta']) {
    for (const p of board[tour] || []) {
      if (p?.id == null) continue;
      const key = String(p.id);
      const prev = map[key] || {};
      const rank = p.rank ?? p.ranking;
      map[key] = {
        current: rank ?? prev.current ?? null,
        previous: p.previousRank ?? prev.previous ?? null,
        best: p.bestRank ?? prev.best ?? null,
        live: prev.live ?? rank ?? null,
        utr: prev.utr ?? null,
      };
    }
  }
  bundle.rankingsByPlayer = map;
  return bundle;
}

function mergeBundleLayers(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const mergedEvents = mergeEventsIntoBundle(base, allEventsFromBundle(extra));
  return {
    ...mergedEvents,
    date: extra.date || mergedEvents.date,
    fetched_at: extra.fetched_at || mergedEvents.fetched_at,
    top100: extra.top100 || mergedEvents.top100,
    rankingsByPlayer: {
      ...(mergedEvents.rankingsByPlayer || {}),
      ...(extra.rankingsByPlayer || {}),
    },
    oddsByEvent: {
      ...(mergedEvents.oddsByEvent || {}),
      ...(extra.oddsByEvent || {}),
    },
    polymarketByEvent: {
      ...(mergedEvents.polymarketByEvent || {}),
      ...(extra.polymarketByEvent || {}),
    },
    eloByEvent: {
      ...(mergedEvents.eloByEvent || {}),
      ...(extra.eloByEvent || {}),
    },
    birthYearByPlayer: {
      ...(mergedEvents.birthYearByPlayer || {}),
      ...(extra.birthYearByPlayer || {}),
    },
    theOddsApiByEvent: {
      ...(mergedEvents.theOddsApiByEvent || {}),
      ...(extra.theOddsApiByEvent || {}),
    },
  };
}

function normalizeTop100Raw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.scheduled?.tournaments?.length) {
    return tennisFromMonitor.normalizeBundle(raw);
  }
  if (Array.isArray(raw.events) && raw.events.length) {
    const scheduled = groupEventsByTournament(raw.events);
    return tennisFromMonitor.normalizeBundle({ ...raw, scheduled });
  }
  return null;
}

async function refreshNewBundleFromMonitor() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let base = await tennisCache.getBundle();
    if (!base) {
      base = await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
    }

    const top100Raw = await fetchMonitorTop100Source();
    const top100Bundle = normalizeTop100Raw(top100Raw);
    if (top100Bundle) {
      base = mergeBundleLayers(base, top100Bundle);
    } else {
      try {
        const liveEvents = await tennisLive.fetchMonitorLiveEventsFresh(false);
        if (liveEvents?.length) {
          base = mergeEventsIntoBundle(base, liveEvents);
        }
      } catch (e) {
        console.error('[tennis/new] live merge:', e.message);
      }
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
        console.error('[tennis/new] live overlay:', e.message);
      }

      mergeTop100BoardRankings(base);
      tennisFromMonitor.buildRankingsFromEvents(base);

    }

    const newBundle = buildNewBundle(base);
    if (!newBundle) throw new Error('failed to build new tennis bundle');

    mergeTop100BoardRankings(newBundle);
    tennisFromMonitor.buildRankingsFromEvents(newBundle);

    newBundle.serverTime = Math.floor(Date.now() / 1000);
    newBundle.fetched_at = newBundle.fetched_at || new Date().toISOString();
    await tennisNewCache.setCachedBundle(newBundle, newBundle.fetched_at);

    const poolCount = allEventsFromBundle(newBundle).filter((m) =>
      passesTopPool(m, NEW_TOP_RANK_MAX, newBundle.rankingsByPlayer || {}),
    ).length;
    const polyCount = Object.values(newBundle.polymarketByEvent || {}).filter((p) => p?.url).length;
    console.log(
      `[tennis/new] cached date=${newBundle.date} events=${newBundle.events} pool=${poolCount} poly=${polyCount}`,
    );
    return newBundle;
  })()
    .catch((e) => {
      console.error('[tennis/new] refresh failed:', e.message);
      throw e;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

module.exports = {
  refreshNewBundleFromMonitor,
  mergeTop100BoardRankings,
};
