/**
 * 盘中 tick：IPWO collect_live 刷比分 + Polymarket 赔率 → 写入盘中包供「比赛进行中」展示
 */
const tennisInplayCache = require('./tennisInplayCache');
const tennisPolymarket = require('./tennisPolymarket');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisEngines = require('./tennisEngines');
const tennisCollectRunner = require('./tennisCollectRunner');

async function stampInplayRefreshTimes(bundle, { score = false, odds = false } = {}) {
  if (!bundle) return bundle;
  const at = new Date().toISOString();
  bundle.tick_at = at;
  bundle.fetched_at = bundle.fetched_at || at;
  bundle.serverTime = Math.floor(Date.now() / 1000);
  bundle.upstream = bundle.upstream || 'ipwo';
  if (score) bundle.score_updated_at = at;
  if (odds) bundle.odds_updated_at = at;
  await tennisInplayCache.setCachedBundle(bundle);
  return bundle;
}

async function runInplayTick({ skipBetting = false } = {}) {
  const tennisDataSource = require('./tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return { ok: false, skipped: true, reason: 'virtual docks500 skips live tick' };
  }
  const cfg = await tennisEngines.getConfig();
  if (cfg.collect?.enabled === false) {
    return { ok: false, skipped: true, reason: 'collect engine disabled' };
  }
  if (cfg.collect?.inplay_tick_enabled === false) {
    return { ok: false, skipped: true, reason: 'tick disabled' };
  }

  const fields = cfg.collect?.inplay_tick_fields || {};
  const wantOdds = fields.odds !== false;
  const wantScore = fields.score !== false;

  const migratePre = await tennisThreeBuckets.migratePrematchByStartTime();

  let scores = { updated: 0, skipped: !wantScore, upstream: 'ipwo' };
  let prices = { updated: 0, failed: 0, skipped: !wantOdds };
  let collectLive = null;

  // 比分：经 IPWO 跑 collect_live.py（Sofascore live → Redis tennis:bundle:inplay）
  // collect_live 同时会刷 Polymarket 价
  if (wantScore) {
    if (!tennisCollectRunner.isLiveCollectAvailable()) {
      scores = {
        updated: 0,
        skipped: true,
        error: 'collect_live.py not found',
        upstream: 'ipwo',
      };
    } else {
      collectLive = await tennisCollectRunner.runLiveCollectAndWait();
      const bundleAfter = await tennisInplayCache.getBundle();
      const n = bundleAfter?.live?.matches?.length || 0;
      const polyN = Object.keys(bundleAfter?.polymarketByEvent || {}).length;
      scores = {
        updated: collectLive?.ok ? n : 0,
        liveFeed: n,
        polymarket: polyN,
        ok: !!collectLive?.ok,
        error: collectLive?.error || collectLive?.last?.error || null,
        timedOut: !!collectLive?.timedOut,
        upstream: 'ipwo',
        script: 'collect_live.py',
        summary: collectLive?.summary || collectLive?.last || null,
        log_tail: collectLive?.log_tail || collectLive?.last?.log_tail || null,
      };
      if (!collectLive?.ok) {
        console.warn('[inplay-tick] collect_live failed:', scores.error);
        if (scores.log_tail) console.warn('[inplay-tick] log_tail:\n', scores.log_tail);
      }
      if (bundleAfter) {
        // collect_live 已含比分 + PM；打上刷新时间供列表展示
        await stampInplayRefreshTimes(bundleAfter, {
          score: true,
          odds: wantOdds,
        });
        if (wantOdds) {
          prices = {
            updated: Object.keys(bundleAfter.polymarketByEvent || {}).length,
            failed: 0,
            skipped: false,
            via: 'collect_live',
            upstream: 'ipwo',
          };
        }
      }
    }
  }

  // 仅开赔率、或比分采集失败时：单独经 IPWO 代理刷 Polymarket
  if (wantOdds && (!wantScore || !collectLive?.ok)) {
    let bundle = await tennisInplayCache.getBundle();
    if (!bundle) {
      const admitLive = await tennisThreeBuckets.admitLiveFromFull();
      bundle = await tennisInplayCache.getBundle();
      prices = {
        ...(prices || {}),
        admitted_live_from_full: admitLive.admitted || 0,
      };
    }
    if (bundle) {
      prices = await tennisPolymarket.refreshPolymarketPrices(bundle);
      prices.upstream = 'ipwo';
      await stampInplayRefreshTimes(bundle, { score: false, odds: true });
    } else {
      prices = { updated: 0, failed: 0, skipped: true, reason: 'no inplay bundle', upstream: 'ipwo' };
    }
  } else if (!wantOdds) {
    prices = { updated: 0, failed: 0, skipped: true, reason: 'odds field off' };
  }

  // 比分关、赔率关时仍做迁桶；比分开时 collect_live 已重写盘中包
  if (!wantScore) {
    await tennisThreeBuckets.admitLiveFromFull();
  }

  const migrateEnd = await tennisThreeBuckets.migrateInplayEnded();
  const bundle = await tennisInplayCache.getBundle();
  const tickAt = bundle?.tick_at || new Date().toISOString();

  let betting = null;
  if (!skipBetting) {
    try {
      const tennisBettingEngine = require('./tennisBettingEngine');
      betting = await tennisBettingEngine.runBettingPass({});
    } catch (e) {
      betting = { ok: false, error: e.message };
    }
  }

  return {
    ok: true,
    tick_at: tickAt,
    score_updated_at: bundle?.score_updated_at || null,
    odds_updated_at: bundle?.odds_updated_at || null,
    fields: { score: wantScore, odds: wantOdds },
    upstream: 'ipwo',
    scores,
    prices,
    collect_live: collectLive
      ? {
          ok: !!collectLive.ok,
          error: collectLive.error || null,
          timedOut: !!collectLive.timedOut,
          last: collectLive.last || null,
        }
      : null,
    migrated_prematch_to_inplay: migratePre.moved || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
    inplay_matches: bundle?.live?.matches?.length || 0,
    betting,
  };
}

module.exports = { runInplayTick };
