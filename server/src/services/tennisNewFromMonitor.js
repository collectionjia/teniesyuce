const tennisCache = require('./tennisCache');
const tennisNewCache = require('./tennisNewCache');
const tennisFromMonitor = require('./tennisFromMonitor');
const tennisLive = require('./tennisLive');
const tennisPolymarket = require('./tennisPolymarket');
const { enrichBundlePolymarket } = require('./tennisPolymarketMatch');
const {
  buildNewBundle,
  allEventsFromBundle,
  groupEventsByTournament,
  passesTop100Pool,
} = require('./tennisRangeFilter');
const { fetchMonitorTop100Source, mergeEventsIntoBundle } = require('./tennisRangeFromMonitor');

let refreshPromise = null;

async function refreshNewBundleFromMonitor() {
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

      try {
        await enrichBundlePolymarket(base);
      } catch (e) {
        console.error('[tennis/new] poly match:', e.message);
      }

      try {
        await tennisPolymarket.refreshPolymarketPrices(base);
      } catch (e) {
        console.error('[tennis/new] poly refresh:', e.message);
      }
    }

    const newBundle = buildNewBundle(base);
    if (!newBundle) throw new Error('failed to build new tennis bundle');

    newBundle.serverTime = Math.floor(Date.now() / 1000);
    newBundle.fetched_at = newBundle.fetched_at || new Date().toISOString();
    await tennisNewCache.setCachedBundle(newBundle, newBundle.fetched_at);

    const poolCount = allEventsFromBundle(base).filter((m) =>
      passesTop100Pool(m, base.rankingsByPlayer || {}),
    ).length;
    console.log(
      `[tennis/new] cached date=${newBundle.date} events=${newBundle.events} top100_pool=${poolCount}`,
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
};
