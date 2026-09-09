const express = require('express');
const { auth } = require('../middleware/auth');

const router = express.Router();

const MONITOR_BASE = (process.env.SOFA_MONITOR_URL || 'http://172.17.0.1:9004').replace(/\/$/, '');
const MONITOR_TOKEN = (process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026').trim();
const MONITOR_FETCH_TIMEOUT_MS = Number(process.env.SOFA_MONITOR_FETCH_TIMEOUT_MS || 15000);

function friendlyMonitorError(err) {
  const msg = String(err?.message || err || '').trim();
  if (!msg) return '监控服务不可达';
  const low = msg.toLowerCase();
  if (low.includes('timeout') || low.includes('aborted') || low.includes('abort')) {
    return '监控服务响应超时，请稍后重试';
  }
  if (low.includes('econnrefused') || low.includes('fetch failed')) {
    return '无法连接采集监控服务（9004），请确认服务已启动';
  }
  return msg;
}

async function monitorFetch(pathname, { method = 'GET', query, timeoutMs } = {}) {
  const url = new URL(pathname, `${MONITOR_BASE}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${MONITOR_TOKEN}`,
    },
    signal: AbortSignal.timeout(timeoutMs ?? MONITOR_FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: text || `HTTP ${res.status}` };
  }
  return { status: res.status, body };
}

function sendProxy(res, result) {
  res.status(result.status).json(result.body);
}

/** 采集结束后：清内存缓存；可选再经 9004 同步 */
function scheduleRedisRefreshAfterCollect() {
  const tennisRedis = require('../services/tennisRedis');
  try {
    tennisRedis.invalidateMemCache();
  } catch { /* ignore */ }
  if (!tennisRedis.monitorSyncEnabled()) {
    console.log('[tennis-monitor] collect 完成，数据由 collect.py 写入 Redis，已清 API 内存缓存');
    try {
      const tennisThreeBuckets = require('../services/tennisThreeBuckets');
      tennisThreeBuckets.splitFullToThreeBuckets().then((r) => {
        console.log('[tennis-monitor] three-buckets split', r);
      }).catch((e) => console.error('[tennis-monitor] three-buckets', e.message));
    } catch { /* ignore */ }
    return;
  }
  const tennisFromMonitor = require('../services/tennisFromMonitor');
  const deadline = Date.now() + 120000;

  const poll = async () => {
    try {
      const { body } = await monitorFetch('/status', { timeoutMs: 10000 });
      if (body?.running || body?.top100_collect?.running) {
        if (Date.now() < deadline) setTimeout(poll, 3000);
        return;
      }
      await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
      console.log('[tennis-monitor] redis refreshed after collect');
      try {
        const tennisLiveFromMonitor = require('../services/tennisLiveFromMonitor');
        await tennisLiveFromMonitor.refreshLiveBundleFromMonitor();
        console.log('[tennis-monitor] redis-live refreshed after collect');
      } catch (err) {
        console.error('[tennis-monitor] redis-live refresh:', err.message);
      }
    } catch (err) {
      console.error('[tennis-monitor] redis refresh:', err.message);
      if (Date.now() < deadline) setTimeout(poll, 5000);
      else tennisFromMonitor.kickRefreshBackground();
    }
  };

  setTimeout(poll, 5000);
}

router.use(auth(['admin']));

router.get('/status', async (_req, res) => {
  try {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    const tennisCache = require('../services/tennisCache');
    let body = { ok: true, monitor_optional: true };
    try {
      const proxied = await monitorFetch('/status', { timeoutMs: 3000 });
      if (proxied.body && typeof proxied.body === 'object') body = { ...proxied.body, ok: true };
    } catch (err) {
      body.monitor_error = friendlyMonitorError(err);
      body.monitor_skipped = true;
    }
    body.schedule = tennisCollectRunner.schedulePayload();
    body.live_poll = tennisCollectRunner.livePayload();
    body.top100_collect = tennisCollectRunner.isCollectAvailable()
      ? tennisCollectRunner.statusPayload()
      : (body.top100_collect || { status: 'remote', script: `${MONITOR_BASE}/collect` });
    body.running = !!(body.top100_collect?.running || tennisCollectRunner.isRunning());
    const bundle = await tennisCache.getBundle();
    if (bundle) {
      body.latest_bundle = {
        ok: true,
        date: bundle.date,
        event_count: bundle.events,
        bundle_file: bundle.bundle_file || null,
        fetched_at: bundle.fetched_at,
      };
    }
    res.json(body);
  } catch (err) {
    console.error('[tennis-monitor/status]', err);
    res.status(500).json({ ok: false, error: err.message || 'status failed' });
  }
});

router.get('/top100', async (req, res) => {
  try {
    sendProxy(
      res,
      await monitorFetch('/top100', {
        query: { refresh: req.query.refresh || '0' },
        timeoutMs: 120000,
      }),
    );
  } catch (err) {
    console.error('[tennis-monitor/top100]', err.message || err);
    // Docker 无 9004：用 Redis bundle 里的榜单占位，避免管理页整页失败
    try {
      const tennisCache = require('../services/tennisCache');
      const bundle = await tennisCache.getBundle();
      const board = bundle?.top100 || bundle?.rankingsBoard || null;
      return res.json({
        ok: true,
        loading: false,
        source: 'redis-fallback',
        monitor_skipped: true,
        atp: board?.atp || [],
        wta: board?.wta || [],
        summary: board?.summary || {
          total_matches: bundle?.events || 0,
          note: '未连接 9004，展示 Redis 缓存；请用「立即采集」',
        },
        error: null,
      });
    } catch {
      res.status(200).json({
        ok: true,
        loading: false,
        source: 'none',
        monitor_skipped: true,
        atp: [],
        wta: [],
        summary: {},
        error: null,
      });
    }
  }
});

router.get('/top20', async (req, res) => {
  try {
    sendProxy(
      res,
      await monitorFetch('/top20', {
        query: { refresh: req.query.refresh || '0' },
      }),
    );
  } catch (err) {
    console.error('[tennis-monitor/top20]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    const lines = Math.min(500, Math.max(20, Number(req.query.lines || 120) || 120));
    let monitorLines = '';
    try {
      const proxied = await monitorFetch('/logs', { query: { lines: String(lines) }, timeoutMs: 8000 });
      monitorLines = proxied.body?.lines || '';
    } catch {
      /* collect.py logs only */
    }
    const collectLines = tennisCollectRunner.recentLogs(lines);
    // collect 日志放最后，避免被 monitor 旧日志挤出 slice(-lines)
    const merged = [monitorLines, collectLines].filter(Boolean).join('\n');
    const parts = merged.split(/\r?\n/).filter((l) => l.length).slice(-lines);
    const text = parts.join('\n');
    res.json({
      ok: true,
      lines: text,
      content: text,
      file: collectLines ? 'collect.py' : 'monitor',
    });
  } catch (err) {
    console.error('[tennis-monitor/logs]', err);
    res.status(500).json({ ok: false, error: err.message || 'logs failed' });
  }
});

router.post('/collect', async (req, res) => {
  try {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    if (!tennisCollectRunner.isCollectAvailable()) {
      return res.status(503).json({
        ok: false,
        error:
          '未找到 collect.py。Docker 部署请确认已挂载 scripts/tennis-monitor 并 rebuild server；'
          + `路径: ${tennisCollectRunner.getCollectScript()}`,
      });
    }
    const matchDate = req.body?.date || req.body?.match_date || null;
    const top100 = req.body?.top100 !== false && req.body?.all !== true;
    const started = tennisCollectRunner.startCollect({ matchDate, top100 });
    if (!started.ok) {
      return res.status(started.status || 409).json({
        ok: false,
        error: started.error || 'collect failed',
        last: started.last,
      });
    }
    res.status(202).json({
      ok: true,
      message: 'collect.py started',
      last: started.last,
      script: 'scripts/tennis-monitor/collect.py',
    });
  } catch (err) {
    console.error('[tennis-monitor/collect]', err);
    res.status(500).json({ ok: false, error: err.message || 'collect failed' });
  }
});

router.get('/live', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/live', { timeoutMs: 3000 }));
  } catch (err) {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    res.json(tennisCollectRunner.livePayload());
  }
});

router.get('/bundle', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/bundle', { timeoutMs: 30000 }));
  } catch (err) {
    console.error('[tennis-monitor/bundle]', err.message || err);
    try {
      const tennisCache = require('../services/tennisCache');
      const bundle = await tennisCache.getBundle();
      if (bundle) return res.json({ ok: true, ...bundle, source: 'redis-fallback' });
    } catch { /* ignore */ }
    res.status(200).json({ ok: false, error: '暂无 bundle（可先立即采集）', source: 'none' });
  }
});

router.post('/live/collect', async (_req, res) => {
  try {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    if (tennisCollectRunner.isLiveCollectAvailable()) {
      const started = tennisCollectRunner.startLiveCollect();
      if (!started.ok) {
        return res.status(started.status || 409).json({
          ok: false,
          error: started.error || 'live collect failed',
          last: started.last,
        });
      }
      scheduleRedisRefreshAfterCollect();
      return res.status(202).json({
        ok: true,
        message: 'collect_live.py started',
        last: started.last,
      });
    }
    sendProxy(res, await monitorFetch('/live/collect', { method: 'POST' }));
    scheduleRedisRefreshAfterCollect();
  } catch (err) {
    console.error('[tennis-monitor/live/collect]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/schedule', async (_req, res) => {
  try {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    res.json(tennisCollectRunner.schedulePayload());
  } catch (err) {
    console.error('[tennis-monitor/schedule]', err);
    res.status(500).json({ ok: false, error: err.message || 'schedule failed' });
  }
});

router.post('/schedule', async (req, res) => {
  try {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    const body = tennisCollectRunner.updateSchedule(req.body || {});
    res.json(body);
  } catch (err) {
    console.error('[tennis-monitor/schedule]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'update schedule failed' });
  }
});

router.get('/data-source', async (_req, res) => {
  try {
    const tennisDataSource = require('../services/tennisDataSource');
    const allsports = require('../services/allsports');
    const tennisCache = require('../services/tennisCache');
    const tennisFromMonitor = require('../services/tennisFromMonitor');
    const pref = await tennisDataSource.get();
    const bundle = await tennisCache.getBundle();
    const lastRedis = tennisFromMonitor.getLastRedisRefresh();
    res.json({
      ok: true,
      source: pref,
      label: tennisDataSource.label(pref),
      api_available: allsports.isConfigured(),
      redis_read: true,
      redis_upstream: bundle?.upstream || bundle?.source || null,
      redis_fetched_at: bundle?.fetched_at || null,
      collect_requests: bundle?.requests || lastRedis?.requests || null,
      poly_match: bundle?.polyMatch || lastRedis?.poly || null,
      redis_refresh: bundle?.redisRefresh || lastRedis?.redisRefresh || null,
    });
  } catch (err) {
    console.error('[tennis-monitor/data-source]', err);
    res.status(500).json({ ok: false, error: err.message || 'read data source failed' });
  }
});

router.post('/data-source', async (req, res) => {
  try {
    const tennisDataSource = require('../services/tennisDataSource');
    const tennisFromMonitor = require('../services/tennisFromMonitor');
    const allsports = require('../services/allsports');
    const next = tennisDataSource.normalize(req.body?.source);
    if (next === 'api' && !allsports.isConfigured()) {
      return res.status(400).json({
        ok: false,
        error: 'AllSports API 未配置（需 RAPIDAPI_KEY），无法切换到 API 源',
      });
    }
    await tennisDataSource.set(next);
    const tennisRedis = require('../services/tennisRedis');
    if (tennisRedis.monitorSyncEnabled()) {
      tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true }).catch((err) => {
        console.error('[tennis-monitor/data-source] redis refresh:', err.message);
      });
    }
    res.json({
      ok: true,
      source: next,
      label: tennisDataSource.label(next),
      api_available: allsports.isConfigured(),
      redis_read: true,
      message: tennisRedis.monitorSyncEnabled()
        ? '已切换写入源，正在从 monitor 刷新 Redis'
        : '已切换写入源；网球列表从 Redis 读取（由 collect.py 写入）',
    });
  } catch (err) {
    console.error('[tennis-monitor/data-source]', err);
    res.status(500).json({ ok: false, error: err.message || 'update data source failed' });
  }
});

router.get('/engines', async (_req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const cfg = await tennisEngines.getConfig();
    res.json({
      ok: true,
      ...cfg,
      allowed_tick_intervals: tennisEngines.ALLOWED_TICK_SEC,
    });
  } catch (err) {
    console.error('[tennis-monitor/engines]', err);
    res.status(500).json({ ok: false, error: err.message || 'engines failed' });
  }
});

router.post('/engines', async (req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const cfg = await tennisEngines.setConfig(req.body || {});
    try {
      const schedulerLoop = require('../services/schedulerLoop');
      const store = require('../services/schedulerStore');
      if (cfg.collect?.inplay_tick_interval_sec != null) {
        await store.syncTickIntervalFromEngines(cfg.collect.inplay_tick_interval_sec);
      }
      // 采集总开关 / tick 开关：同步盘中 tick 任务 enabled
      if (cfg.collect) {
        const tickOn =
          cfg.collect.enabled !== false && cfg.collect.inplay_tick_enabled !== false;
        await store.setJobEnabled('job_collect_inplay_tick', tickOn);
      }
      await schedulerLoop.alignTickJobFromConfig();
    } catch (e) {
      console.warn('[tennis-monitor/engines] scheduler sync', e.message);
      const tennisInplayTickLoop = require('../services/tennisInplayTickLoop');
      tennisInplayTickLoop.resyncFromConfig().catch(() => {});
    }
    res.json({ ok: true, ...cfg, allowed_tick_intervals: tennisEngines.ALLOWED_TICK_SEC });
  } catch (err) {
    console.error('[tennis-monitor/engines]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'update engines failed' });
  }
});

router.post('/engines/split-buckets', async (_req, res) => {
  try {
    const tennisThreeBuckets = require('../services/tennisThreeBuckets');
    const r = await tennisThreeBuckets.splitFullToThreeBuckets();
    await tennisThreeBuckets.migratePrematchByStartTime();
    await tennisThreeBuckets.migrateInplayEnded();
    res.json(r);
  } catch (err) {
    console.error('[tennis-monitor/split-buckets]', err);
    res.status(500).json({ ok: false, error: err.message || 'split failed' });
  }
});

module.exports = router;
