/**
 * 盘中 tick：读 Redis tennis:bundle:inplay 已有场次 → 只刷比分(Sofascore) + Polymarket 赔率
 */
const tennisInplayCache = require('./tennisInplayCache');
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
    return {
      ok: false,
      skipped: true,
      reason: 'virtual docks500 skips live tick',
      process_log: '[inplay-tick] skipped: virtual docks500',
    };
  }
  const cfg = await tennisEngines.getConfig();
  if (cfg.collect?.enabled === false) {
    return {
      ok: false,
      skipped: true,
      reason: 'collect engine disabled',
      process_log: '[inplay-tick] skipped: collect engine disabled',
    };
  }
  if (cfg.collect?.inplay_tick_enabled === false) {
    return {
      ok: false,
      skipped: true,
      reason: 'tick disabled',
      process_log: '[inplay-tick] skipped: inplay_tick disabled',
    };
  }

  const fields = cfg.collect?.inplay_tick_fields || {};
  const wantOdds = fields.odds !== false;
  const wantScore = fields.score !== false;

  const migratePre = await tennisThreeBuckets.migratePrematchByStartTime();
  // 确保盘中包有已开赛场次（从全量/赛前迁入），再只刷这些 id
  const admitLive = await tennisThreeBuckets.admitLiveFromFull();

  Object.assign(process.env, (() => {
    try {
      return tennisEngines.buildProxyProcessEnv(cfg, 'inplay');
    } catch {
      return { COLLECT_PROXY_JOB: 'inplay', COLLECT_INPLAY_USE_PROXY: '1', COLLECT_TOP100_USE_PROXY: '1' };
    }
  })());

  let scores = { updated: 0, skipped: !wantScore, upstream: 'ipwo' };
  let prices = { updated: 0, failed: 0, skipped: !wantOdds };
  let refresh = null;

  let bundle = await tennisInplayCache.getBundle();
  const matchCount = bundle?.live?.matches?.length || 0;

  if (!matchCount) {
    scores = {
      updated: 0,
      skipped: true,
      reason: 'no inplay matches in redis',
      upstream: 'ipwo',
    };
    prices = {
      updated: 0,
      failed: 0,
      skipped: true,
      reason: 'no inplay matches in redis',
      upstream: 'ipwo',
    };
  } else if (wantScore || wantOdds) {
    if (!tennisCollectRunner.isInplayRefreshAvailable()) {
      const err = 'refresh_inplay.py not found';
      if (wantScore) scores = { updated: 0, skipped: true, error: err, upstream: 'ipwo' };
      if (wantOdds) prices = { updated: 0, failed: 0, skipped: true, error: err, upstream: 'ipwo' };
    } else {
      refresh = await tennisCollectRunner.runInplayRefreshAndWait({
        scoresOnly: wantScore && !wantOdds,
        oddsOnly: wantOdds && !wantScore,
      });
      const summary = refresh?.summary || {};
      const s = summary.scores || {};
      const p = summary.prices || {};
      if (wantScore) {
        scores = {
          updated: Number(s.updated) || 0,
          failed: Number(s.failed) || 0,
          liveFeed: s.live_feed ?? null,
          tracked: s.tracked ?? matchCount,
          ok: refresh?.ok !== false && s.ok !== false,
          error: s.error || (!refresh?.ok ? refresh?.error : null) || null,
          timedOut: !!refresh?.timedOut,
          upstream: 'ipwo',
          script: 'refresh_inplay.py',
          summary: s,
        };
      }
      if (wantOdds) {
        prices = {
          updated: Number(p.updated) || 0,
          failed: Number(p.failed) || 0,
          skipped: !!p.skipped,
          ok: refresh?.ok !== false && p.ok !== false,
          error: p.error || (!refresh?.ok && !wantScore ? refresh?.error : null) || null,
          via: 'polymarket-gamma',
          upstream: 'ipwo',
          script: 'refresh_inplay.py',
          summary: p,
        };
      }
      if (!refresh?.ok) {
        console.warn('[inplay-tick] refresh_inplay failed:', refresh?.error);
        if (refresh?.log_tail) console.warn('[inplay-tick] log_tail:\n', refresh.log_tail);
      }
      if (wantScore && (scores.error || scores.ok === false || Number(scores.failed) > 0)) {
        console.warn('[inplay-tick] score collection failed:', {
          updated: scores.updated,
          failed: scores.failed,
          tracked: scores.tracked,
          liveFeed: scores.liveFeed,
          error: scores.error,
          missed: scores.summary?.missed || null,
        });
        if (refresh?.log_tail) console.warn('[inplay-tick] score log_tail:\n', refresh.log_tail);
      }
      if (wantOdds && Number(prices.failed) > 0) {
        console.warn('[inplay-tick] odds collection failed:', {
          updated: prices.updated,
          failed: prices.failed,
          error: prices.error,
          failures: prices.summary?.failures || null,
        });
        if (refresh?.ok && refresh?.log_tail) {
          console.warn('[inplay-tick] odds log_tail:\n', refresh.log_tail);
        }
      }
      bundle = await tennisInplayCache.getBundle();
      if (bundle) {
        await stampInplayRefreshTimes(bundle, {
          score: wantScore && scores.ok !== false,
          odds: wantOdds && prices.ok !== false,
        });
      }
    }
  }

  const migrateEnd = await tennisThreeBuckets.migrateInplayEnded();
  bundle = await tennisInplayCache.getBundle();
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
    score_failures: wantScore ? (scores.summary?.missed || scores.error || null) : null,
    odds_failures: wantOdds ? (prices.summary?.failures || null) : null,
    // 采集过程完整日志（写入 scheduler_runs.metrics_json，供「详细日志」展示）
    process_log:
      refresh?.process_log
      || refresh?.log_tail
      || [
          `[inplay-tick] matches=${matchCount}`,
          wantScore ? `[score] updated=${scores.updated ?? 0} failed=${scores.failed ?? 0} error=${scores.error || '-'}` : '[score] skipped',
          wantOdds ? `[odds] updated=${prices.updated ?? 0} failed=${prices.failed ?? 0} error=${prices.error || '-'}` : '[odds] skipped',
          refresh == null ? '[refresh_inplay] not run' : null,
        ]
          .filter(Boolean)
          .join('\n'),
    log_tail: refresh?.log_tail || null,
    refresh_inplay: refresh
      ? {
          ok: !!refresh.ok,
          error: refresh.error || null,
          timedOut: !!refresh.timedOut,
          summary: refresh.summary || null,
          process_log: refresh.process_log || refresh.log_tail || null,
          log_tail: refresh.log_tail || null,
        }
      : null,
    admitted_live_from_full: admitLive?.admitted || 0,
    migrated_prematch_to_inplay: migratePre.moved || 0,
    migrated_inplay_to_settled: migrateEnd.moved || 0,
    inplay_matches: bundle?.live?.matches?.length || 0,
    betting,
  };
}

module.exports = { runInplayTick, stampInplayRefreshTimes };
