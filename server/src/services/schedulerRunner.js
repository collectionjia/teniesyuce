/**
 * 调度任务执行：定时可互斥跳过；立即执行（manual）可并行
 */
const tennisEngines = require('./tennisEngines');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const tennisInplayTick = require('./tennisInplayTick');
const tennisBettingEngine = require('./tennisBettingEngine');
const store = require('./schedulerStore');
const schedulerTelegram = require('./schedulerTelegram');

function fireTelegramNotify(ctx) {
  void schedulerTelegram.notifyRun(ctx).catch((e) => {
    console.warn('[scheduler/telegram]', e?.message || e);
  });
}

/** jobId -> 本地定时互斥（单进程）；manual 不占用 */
const scheduleLocks = new Map();

async function engineGate(requireEngineOn) {
  if (!requireEngineOn) return { ok: true };
  const cfg = await tennisEngines.getConfig();
  if (requireEngineOn === 'collect') {
    if (cfg.collect?.enabled === false) {
      return { ok: false, reason: 'collect engine off' };
    }
    return { ok: true };
  }
  if (requireEngineOn === 'betting') {
    if (cfg.betting?.enabled === false) {
      return { ok: false, reason: 'betting engine off' };
    }
    return { ok: true };
  }
  if (requireEngineOn === 'condition') {
    const buckets = cfg.condition?.buckets || {};
    const anyOn = ['prematch', 'inplay', 'settled'].some((k) => buckets[k]?.enabled);
    if (!anyOn) {
      return { ok: false, reason: 'condition buckets all off' };
    }
    return { ok: true };
  }
  return { ok: true };
}

async function executeJobType(job, params = {}) {
  const tennisDataSource = require('./tennisDataSource');
  const isVirtual = (await tennisDataSource.get()) === 'docks500';

  switch (job.jobType) {
    case 'collect.full': {
      // 虚拟：只从 docks/2026_500.txt 造数，不拆官网全量包
      if (isVirtual) {
        const r = await tennisThreeBuckets.seedVirtualPrematchInplay({
          txtName: '2026_500.txt',
          prematchCount: params.prematchCount,
          inplayCount: params.inplayCount,
        });
        if (!r.ok) throw new Error(r.error || 'virtual txt seed failed');
        return {
          message: r.message || 'collect.full virtual txt done',
          metrics: r,
        };
      }
      const split = await tennisThreeBuckets.splitFullToThreeBuckets();
      const migP = await tennisThreeBuckets.migratePrematchByStartTime();
      const migI = await tennisThreeBuckets.migrateInplayEnded();
      return {
        message: 'collect.full done',
        metrics: { split, migratePrematch: migP, migrateInplay: migI },
      };
    }
    case 'collect.dota2':
    case 'collect.dota2_hf': {
      const dota2PmCollect = require('./dota2PmCollect');
      const bundle = await dota2PmCollect.collectDirect();
      if (bundle?.ok === false) throw new Error(bundle.error || 'dota2 polymarket collect failed');
      return {
        message: `dota2 polymarket ${bundle.matchCount ?? 0} matches`,
        metrics: {
          matchCount: bundle.matchCount ?? 0,
          scanned: bundle.scanned ?? 0,
          source: bundle.source || 'polymarket-gamma',
        },
      };
    }
    case 'collect.nfl':
    case 'collect.nfl_hf': {
      const dota2PmCollect = require('./dota2PmCollect');
      const bundle = await dota2PmCollect.collectNfl();
      if (bundle?.ok === false) throw new Error(bundle.error || 'nfl polymarket collect failed');
      return {
        message: `nfl polymarket ${bundle.matchCount ?? 0} matches`,
        metrics: {
          matchCount: bundle.matchCount ?? 0,
          scanned: bundle.scanned ?? 0,
          source: bundle.source || 'polymarket-gamma',
        },
      };
    }
    case 'collect.top100': {
      if (isVirtual) {
        return { skipped: true, message: '虚拟(txt)模式跳过官网 Top100 采集' };
      }
      const tennisCollectRunner = require('./tennisCollectRunner');
      if (tennisCollectRunner.isRunning()) {
        return { skipped: true, message: 'tennisFullCollect already running' };
      }
      const started = await tennisCollectRunner.startCollect({
        matchDate: params.matchDate || null,
        top100: params.top100 !== false,
      });
      if (!started.ok) throw new Error(started.error || 'collect.top100 start failed');
      return { message: 'collect.top100 started', metrics: started.last || {} };
    }
    case 'collect.inplay_tick': {
      if (isVirtual) {
        return { skipped: true, message: '虚拟(txt)模式跳过盘中迁桶' };
      }
      const r = await tennisInplayTick.runInplayTick();
      return { message: '盘中迁桶完成', metrics: r || {} };
    }
    case 'collect.top100_hf': {
      if (isVirtual) {
        return { skipped: true, message: '虚拟(txt)模式跳过 Top100 高频赔率刷新' };
      }
      const r = await tennisInplayTick.refreshInplayOddsTick();
      return { message: 'Top100 高频赔率刷新完成', metrics: r || {} };
    }
    case 'condition.query': {
      const tennisConditionApply = require('./tennisConditionApply');
      const tennisPrematchCache = require('./tennisPrematchCache');
      const tennisInplayCache = require('./tennisInplayCache');
      const tennisSettledCache = require('./tennisSettledCache');
      const caches = {
        prematch: tennisPrematchCache,
        inplay: tennisInplayCache,
        settled: tennisSettledCache,
      };
      const cfg = await tennisEngines.getConfig();
      const onlyBucket = params.bucket;
      const groupIndex = params.groupIndex != null ? Number(params.groupIndex) : null;
      const keys = onlyBucket && caches[onlyBucket] ? [onlyBucket] : Object.keys(caches);
      const metrics = {};

      function countBundle(key, bundle) {
        if (!bundle) return 0;
        if (key === 'prematch') return Number(bundle.scheduled?.eventCount || bundle.events || 0);
        return Number(bundle.live?.eventCount || bundle.events || (bundle.live?.matches || []).length || 0);
      }

      let betting = null;
      for (const key of keys) {
        let bundle = await caches[key].getBundle();
        const before = countBundle(key, bundle);
        let matched = false;
        if (bundle && (cfg.condition?.buckets?.[key]?.enabled)) {
          const full = cfg.condition?.buckets?.[key];
          let groups = full?.groups || [];
          if (groupIndex != null) {
            if (!groups[groupIndex]) {
              metrics[key] = {
                before,
                after: before,
                groupName: params.groupName || null,
                groupIndex,
                error: 'condition group not found',
              };
              continue;
            }
            groups = [groups[groupIndex]];
          }
          const useBucket = { enabled: true, groups };
          if (groups.length) {
            if (key === 'prematch') {
              bundle = tennisConditionApply.applyToPrematchBundle(bundle, useBucket);
            } else {
              bundle = tennisConditionApply.applyToInplayBundle(bundle, useBucket);
            }
          }
        }
        const after = countBundle(key, bundle);
        matched = after > 0 && groupIndex != null && (key === 'prematch' || key === 'inplay');
        metrics[key] = {
          before,
          after,
          groupName: params.groupName || null,
          groupIndex,
          matched,
        };
        if (matched) {
          try {
            betting = await tennisBettingEngine.runBettingPass({
              amountUsd: Number(params.amountUsd ?? cfg.betting?.amountUsd ?? 1),
              userId: params.userId ?? cfg.betting?.userId,
              onlyBucket: key,
              conditionGroupIndex: groupIndex,
              mode: 'buy',
            });
          } catch (e) {
            betting = { ok: false, error: e.message };
          }
        }
      }
      if (betting) metrics.betting = betting;
      return { message: 'condition.query done', metrics };
    }
    case 'bet.scan': {
      const cfg = await tennisEngines.getConfig();
      const amountUsd = Number(params.amountUsd ?? cfg.betting?.amountUsd ?? 1);
      const userId = params.userId ?? cfg.betting?.userId;
      const r = await tennisBettingEngine.runBettingPass({
        amountUsd,
        userId,
        onlyBucket: params.bucket || null,
        onlyGroupIndex: params.groupIndex != null ? Number(params.groupIndex) : null,
        onlyStrategyKey: params.strategyKey || null,
        mode: params.mode === 'stop' ? 'stop' : (params.mode === 'both' ? 'both' : 'buy'),
      });
      return { message: 'bet.scan done', metrics: r || {} };
    }
    case 'bet.stop_loss': {
      const cfg = await tennisEngines.getConfig();
      const r = await tennisBettingEngine.runBettingPass({
        amountUsd: Number(params.amountUsd ?? cfg.betting?.amountUsd ?? 1),
        userId: params.userId ?? cfg.betting?.userId,
        onlyBucket: params.bucket || null,
        onlyGroupIndex: params.groupIndex != null ? Number(params.groupIndex) : null,
        onlyStrategyKey: params.strategyKey || null,
        mode: 'stop',
      });
      return { message: 'bet.stop_loss done', metrics: r || {} };
    }
    default: {
      const err = new Error(`unsupported jobType: ${job.jobType}`);
      err.status = 400;
      throw err;
    }
  }
}

/**
 * @param {string} jobId
 * @param {'schedule'|'manual'} trigger
 */
async function runJob(jobId, trigger = 'manual') {
  const job = await store.getJob(jobId);
  if (!job) {
    const err = new Error('job not found');
    err.status = 404;
    throw err;
  }

  if (trigger === 'schedule' && !job.enabled) {
    return { accepted: false, status: 'skipped', message: 'job disabled' };
  }

  const gate = await engineGate(job.requireEngineOn);
  if (!gate.ok) {
    if (trigger === 'schedule') {
      return { accepted: false, status: 'skipped', message: gate.reason };
    }
    const runId = await store.startRun({ jobId, trigger });
    await store.finishRun(runId, { status: 'skipped', message: gate.reason });
    fireTelegramNotify({ job, trigger, status: 'skipped', message: gate.reason });
    return { accepted: true, runId, status: 'skipped', message: gate.reason };
  }

  if (trigger === 'schedule') {
    const lockKey = job.mutexKey || job.id;
    if (job.skipIfRunning) {
      if (scheduleLocks.get(lockKey) || (await store.hasRunningSchedule(job.id))) {
        return { accepted: false, status: 'skipped', message: 'previous schedule still running' };
      }
    }
    scheduleLocks.set(lockKey, true);
  }

  const runId = await store.startRun({ jobId, trigger });
  const timeoutMs = Math.max(5, Number(job.timeoutSec || 300)) * 1000;
  let timedOut = false;

  const work = (async () => {
    try {
      const result = await executeJobType(job, job.params || {});
      if (timedOut) return { accepted: true, runId, status: 'timeout' };
      if (result?.skipped) {
        await store.finishRun(runId, {
          status: 'skipped',
          message: result.message || 'skipped',
          metrics: result.metrics || null,
        });
        fireTelegramNotify({
          job, trigger, status: 'skipped', message: result.message, metrics: result.metrics,
        });
        return { accepted: true, runId, status: 'skipped', message: result.message };
      }
      await store.finishRun(runId, {
        status: 'success',
        message: result?.message || 'ok',
        metrics: result?.metrics || null,
      });
      fireTelegramNotify({
        job, trigger, status: 'success', message: result?.message, metrics: result?.metrics,
      });
      return { accepted: true, runId, status: 'success', message: result?.message, metrics: result?.metrics };
    } catch (e) {
      if (timedOut) return { accepted: true, runId, status: 'timeout' };
      await store.finishRun(runId, {
        status: 'failed',
        error: e.message || String(e),
      });
      fireTelegramNotify({ job, trigger, status: 'failed', error: e.message || String(e) });
      return { accepted: true, runId, status: 'failed', error: e.message || String(e) };
    } finally {
      if (trigger === 'schedule') {
        scheduleLocks.delete(job.mutexKey || job.id);
      }
    }
  })();

  let timer;
  const raced = await Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(async () => {
        timedOut = true;
        // 只记超时状态，不解锁：等 work.finally 释放，避免超时后重叠跑 bet.scan
        try {
          await store.finishRun(runId, { status: 'timeout', error: `timeout ${job.timeoutSec}s` });
          fireTelegramNotify({
            job, trigger, status: 'timeout', error: `timeout ${job.timeoutSec}s`,
          });
        } catch { /* ignore */ }
        resolve({ accepted: true, runId, status: 'timeout' });
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return raced;
}

module.exports = { runJob, executeJobType, engineGate };
