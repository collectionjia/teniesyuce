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
    const tennisDataSource = require('../services/tennisDataSource');
    const pref = await tennisDataSource.get();
    let body = { ok: true, monitor_optional: true, data_source: pref };
    const localCollect = tennisCollectRunner.isCollectAvailable();

    // 虚拟模式 / 本机已有 collect runner：不探测远端 monitor（本地常 3–6s 超时）
    if (pref === 'docks500') {
      body.monitor_skipped = true;
      body.virtual = true;
      body.txtSource = '2026_500.txt';
      body.message = '虚拟(txt)模式：不连接官网采集服务';
    } else if (localCollect) {
      body.monitor_skipped = true;
      body.monitor_local = true;
    } else {
      try {
        const proxied = await monitorFetch('/status', { timeoutMs: 800 });
        if (proxied.body && typeof proxied.body === 'object') {
          body = { ...proxied.body, ok: true, data_source: pref };
        }
      } catch (err) {
        body.monitor_error = friendlyMonitorError(err);
        body.monitor_skipped = true;
      }
    }
    body.schedule = tennisCollectRunner.schedulePayload();
    body.live_poll = tennisCollectRunner.livePayload();
    body.top100_collect = pref === 'docks500'
      ? { status: 'virtual-txt', script: 'docks/2026_500.txt', running: false }
      : (localCollect
        ? tennisCollectRunner.statusPayload()
        : (body.top100_collect || { status: 'remote', script: `${MONITOR_BASE}/collect` }));
    body.running = pref === 'docks500'
      ? false
      : !!(body.top100_collect?.running || tennisCollectRunner.isRunning());

    // bundle 摘要：短超时，失败不影响 status 主体
    try {
      const bundle = await Promise.race([
        tennisCache.getBundle(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('bundle timeout')), 1200)),
      ]);
      if (bundle) {
        body.latest_bundle = {
          ok: true,
          date: bundle.date,
          event_count: bundle.events,
          bundle_file: bundle.bundle_file || null,
          fetched_at: bundle.fetched_at,
          source: bundle.source || bundle.dataSource || null,
        };
      }
    } catch {
      body.latest_bundle_skipped = true;
    }
    res.json(body);
  } catch (err) {
    console.error('[tennis-monitor/status]', err);
    res.status(500).json({ ok: false, error: err.message || 'status failed' });
  }
});

router.get('/top100', async (req, res) => {
  try {
    const tennisDataSource = require('../services/tennisDataSource');
    const tennisCache = require('../services/tennisCache');

    function payloadFromRedisBundle(bundle, extra = {}) {
      const board = bundle?.top100 || bundle?.rankingsBoard || null;
      const atp = board?.atp || [];
      const wta = board?.wta || [];
      return {
        ok: true,
        loading: false,
        date: bundle?.date || null,
        fetched_at: bundle?.fetched_at || board?.fetched_at || null,
        atp,
        wta,
        top100: board,
        rankingsByPlayer: bundle?.rankingsByPlayer || {},
        summary: board?.summary || {
          total_matches: bundle?.events || 0,
          atp_players: atp.length,
          wta_players: wta.length,
        },
        error: null,
        ...extra,
      };
    }

    if ((await tennisDataSource.get()) === 'docks500') {
      const bundle = await tennisCache.getBundle();
      return res.json(payloadFromRedisBundle(bundle, {
        virtual: true,
        source: 'docks500',
        txtSource: '2026_500.txt',
        message: '虚拟模式：榜单来自 txt 模拟包，未采官网',
      }));
    }

    let monitorBody = null;
    try {
      const proxied = await monitorFetch('/top100', {
        query: { refresh: req.query.refresh || '0' },
        timeoutMs: 120000,
      });
      monitorBody = proxied?.body || null;
    } catch (e) {
      console.warn('[tennis-monitor/top100] monitor:', e.message || e);
    }

    const hasPlayers = !!(
      (monitorBody?.atp && monitorBody.atp.length)
      || (monitorBody?.wta && monitorBody.wta.length)
      || (monitorBody?.top100?.atp && monitorBody.top100.atp.length)
      || (monitorBody?.top100?.wta && monitorBody.top100.wta.length)
    );
    if (monitorBody && hasPlayers && monitorBody.loading !== true) {
      const atp = monitorBody.atp || monitorBody.top100?.atp || [];
      const wta = monitorBody.wta || monitorBody.top100?.wta || [];
      return res.json({
        ...monitorBody,
        ok: true,
        atp,
        wta,
        source: monitorBody.source || 'monitor',
      });
    }

    // collect.py 写入 Redis 的榜单（不依赖 9004 内存）
    const bundle = await tennisCache.getBundle();
    const fromRedis = payloadFromRedisBundle(bundle, {
      source: 'redis',
      monitor_skipped: !monitorBody,
      message: monitorBody?.loading
        ? 'Top100 采集中…'
        : '展示 Redis 缓存榜单（真实采集写入）；若为空请再点「立即采集 Top100」',
      loading: !!monitorBody?.loading,
      error: monitorBody?.error || null,
    });
    if (fromRedis.atp.length || fromRedis.wta.length || monitorBody?.loading) {
      return res.json(fromRedis);
    }
    return res.json({
      ok: true,
      loading: false,
      atp: [],
      wta: [],
      source: 'empty',
      summary: { total_matches: 0, atp_players: 0, wta_players: 0 },
      error: monitorBody?.error || '暂无 Top100 球员榜，请先「立即采集 Top100」',
      message: '暂无 Top100 球员榜，请先「立即采集 Top100」',
    });
  } catch (err) {
    console.error('[tennis-monitor/top100]', err.message || err);
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
          note: '未连接监控，展示 Redis 缓存；请用「立即采集」',
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
    const tennisDataSource = require('../services/tennisDataSource');
    const tennisThreeBuckets = require('../services/tennisThreeBuckets');
    const tennisCache = require('../services/tennisCache');
    const pref = await tennisDataSource.get();
    const wantTxt =
      pref === 'docks500'
      || req.body?.fromTxt === true
      || req.body?.virtual === true
      || String(req.body?.source || '').toLowerCase() === 'docks500';

    // 虚拟采集：引用 docks/2026_500.txt 模拟造盘前/盘中/盘后
    if (wantTxt) {
      const r = await tennisThreeBuckets.seedVirtualPrematchInplay({
        txtName: '2026_500.txt',
        date: req.body?.date || req.body?.match_date || null,
        prematchCount: req.body?.prematchCount ?? 12,
        inplayCount: req.body?.inplayCount ?? 12,
        forceRebuild: req.body?.forceRebuild === true,
      });
      if (!r.ok) {
        return res.status(r.error?.includes('Redis') ? 503 : 400).json(r);
      }
      // 清一下内存缓存，列表立刻读到新桶
      try {
        await tennisCache.invalidateCache?.();
      } catch (_) {
        /* ignore */
      }
      return res.json({
        ok: true,
        virtual: true,
        message: r.message,
        txtSource: r.txtSource || '2026_500.txt',
        date: r.date,
        prematch: r.prematch,
        inplay: r.inplay,
        settled: r.settled,
        virtualSim: r.virtualSim || null,
        last: {
          status: 'success',
          message: r.message,
          finished_at: new Date().toISOString(),
          event_count: (r.prematch || 0) + (r.inplay || 0) + (r.settled || 0),
        },
      });
    }

    // 真实模式且显式禁止 txt 时，绝不走官网以外的虚拟路径
    if (req.body?.fromTxt === false && pref === 'docks500') {
      return res.status(400).json({
        ok: false,
        error: '当前为虚拟(txt)数据源，请先关闭「虚拟」再采官网；或点「立即采集（仅 txt）」',
      });
    }

    const engineServices = require('../services/engineServicesClient');
    const matchDate = req.body?.date || req.body?.match_date || null;
    const top100 = req.body?.top100 !== false && req.body?.all !== true;
    const data = await engineServices.collectFull({
      sport: 'tennis',
      top100,
      matchDate,
      date: matchDate,
    });
    if (data.skipped) {
      return res.status(409).json({ ok: false, error: data.message || 'collect skipped', ...data });
    }
    res.status(202).json({
      ok: true,
      message: data.message || 'collect started',
      metrics: data.metrics || null,
      service: 'collect',
    });
  } catch (err) {
    console.error('[tennis-monitor/collect]', err);
    res.status(500).json({ ok: false, error: err.message || 'collect failed' });
  }
});

router.get('/live', async (_req, res) => {
  try {
    const tennisDataSource = require('../services/tennisDataSource');
    if ((await tennisDataSource.get()) === 'docks500') {
      const tennisInplayCache = require('../services/tennisInplayCache');
      const bundle = await tennisInplayCache.getBundle();
      return res.json({
        ok: true,
        virtual: true,
        source: 'docks500',
        txtSource: '2026_500.txt',
        running: false,
        events: bundle?.live?.matches || [],
        event_count: bundle?.live?.eventCount ?? (bundle?.live?.matches || []).length,
        message: '虚拟模式：盘中来自 docks/2026_500.txt，未采官网',
      });
    }
    sendProxy(res, await monitorFetch('/live', { timeoutMs: 3000 }));
  } catch (err) {
    const tennisCollectRunner = require('../services/tennisCollectRunner');
    res.json(tennisCollectRunner.livePayload());
  }
});

router.get('/bundle', async (_req, res) => {
  try {
    const tennisDataSource = require('../services/tennisDataSource');
    const tennisCache = require('../services/tennisCache');

    async function fromRedis(extra = {}) {
      const bundle = await tennisCache.getBundle();
      if (!bundle) return null;
      return { ok: true, ...bundle, ...extra };
    }

    if ((await tennisDataSource.get()) === 'docks500') {
      const payload = await fromRedis({ source: 'docks500', virtual: true });
      if (payload) return res.json(payload);
      return res.status(200).json({
        ok: false,
        error: '虚拟模式暂无数据，请点「立即采集（仅 txt）」',
        source: 'docks500',
      });
    }

    // 宽屏/看板优先 Redis 采集包（含 Top100 赛事），监控仅作补充
    const redisPayload = await fromRedis({ source: 'redis' });
    if (redisPayload && (Number(redisPayload.events) > 0 || redisPayload.scheduled?.tournaments?.length)) {
      return res.json(redisPayload);
    }

    try {
      const proxied = await monitorFetch('/bundle', { timeoutMs: 30000 });
      if (proxied?.body && (proxied.body.ok !== false)) {
        return sendProxy(res, proxied);
      }
    } catch (e) {
      console.warn('[tennis-monitor/bundle] monitor:', e.message || e);
    }

    if (redisPayload) return res.json({ ...redisPayload, source: 'redis-fallback' });
    return res.status(200).json({ ok: false, error: '暂无 bundle（可先立即采集）', source: 'none' });
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
    const tennisDataSource = require('../services/tennisDataSource');
    // 虚拟：不跑 collect_live / 不打官网，只用 2026_500.txt 重模拟
    if ((await tennisDataSource.get()) === 'docks500') {
      const tennisThreeBuckets = require('../services/tennisThreeBuckets');
      const tennisCache = require('../services/tennisCache');
      const r = await tennisThreeBuckets.seedVirtualPrematchInplay({
        txtName: '2026_500.txt',
        prematchCount: 12,
        inplayCount: 12,
      });
      if (!r.ok) {
        return res.status(r.error?.includes('Redis') ? 503 : 400).json(r);
      }
      try {
        await tennisCache.invalidateCache?.();
      } catch (_) {
        /* ignore */
      }
      return res.json({
        ok: true,
        virtual: true,
        message: r.message || '虚拟盘中已由 docks/2026_500.txt 重模拟（未采官网）',
        txtSource: '2026_500.txt',
        ...r,
      });
    }

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
    const tennisDocks500 = require('../services/tennisDocks500');
    const pref = await tennisDataSource.get();
    const bundle = await tennisCache.getBundle();
    const lastRedis = tennisFromMonitor.getLastRedisRefresh();
    let docks500 = null;
    try {
      try {
        tennisDocks500.ensureByDayFromTxt();
      } catch (_) {
        /* txt 缺失时仍返回空 days */
      }
      const days = tennisDocks500.listDays();
      const date = await tennisDocks500.getSelectedDate();
      let txtSource = null;
      try {
        const p = tennisDocks500.resolveTxtPath();
        if (require('fs').existsSync(p)) txtSource = require('path').basename(p);
      } catch (_) {
        /* ignore */
      }
      docks500 = { days, date, available: days.length > 0, txtSource };
    } catch (e) {
      docks500 = { days: [], date: null, available: false, error: e.message };
    }
    res.json({
      ok: true,
      source: pref,
      label: tennisDataSource.label(pref),
      api_available: allsports.isConfigured(),
      docks500_available: !!docks500?.available,
      docks500,
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
    const tennisDocks500 = require('../services/tennisDocks500');
    const next = tennisDataSource.normalize(req.body?.source);
    if (next === 'api' && !allsports.isConfigured()) {
      return res.status(400).json({
        ok: false,
        error: 'AllSports API 未配置（需 RAPIDAPI_KEY），无法切换到 API 源',
      });
    }
    if (next === 'docks500') {
      try {
        tennisDocks500.ensureByDayFromTxt();
      } catch (e) {
        return res.status(400).json({ ok: false, error: e.message || 'docks txt 不可用' });
      }
      if (req.body?.date) {
        await tennisDocks500.setSelectedDate(req.body.date);
      } else {
        const days = tennisDocks500.listDays();
        if (!days.length) {
          return res.status(400).json({
            ok: false,
            error: 'docks txt 无可用按日数据（检查 2026_all_gs_1000_500.txt / 2026_500.txt）',
          });
        }
        await tennisDocks500.setSelectedDate(days[0].date);
      }
    }
    await tennisDataSource.set(next);
    let refreshed = null;
    let refreshError = null;
    try {
      if (next === 'docks500') {
        // 切回模拟：与采集引擎「仅 txt」同一路径，强制重写三桶，避免盘中仍留线上数据
        const tennisThreeBuckets = require('../services/tennisThreeBuckets');
        const seeded = await tennisThreeBuckets.seedVirtualPrematchInplay({
          date: req.body?.date || (await tennisDocks500.getSelectedDate()),
          txtName: '2026_500.txt',
          prematchCount: 12,
          inplayCount: 12,
        });
        if (!seeded?.ok) {
          throw Object.assign(new Error(seeded?.error || '虚拟三桶写入失败'), { status: 500 });
        }
        refreshed = {
          upstream: 'docks500',
          dataSource: 'docks500',
          date: seeded.date,
          bucketSplit: {
            prematch: seeded.prematch,
            inplay: seeded.inplay,
            settled: seeded.settled,
          },
          virtualSim: seeded.virtualSim || null,
          message: seeded.message,
        };
      } else {
        // 真实：拉官网/API 并拆三桶
        refreshed = await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
      }
    } catch (e) {
      refreshError = e;
      if (next === 'docks500') {
        return res.status(e.status || 500).json({ ok: false, error: e.message || '刷新虚拟数据失败' });
      }
      console.warn('[tennis-monitor/data-source] real refresh failed:', e.message);
      try {
        const tennisCache = require('../services/tennisCache');
        const tennisThreeBuckets = require('../services/tennisThreeBuckets');
        const full = await tennisCache.getBundle();
        const stillVirtual = !!(full && (
          full.upstream === 'docks500'
          || full.dataSource === 'docks500'
          || full.source === 'docks500'
          || full.virtualSim
        ));
        if (full && !stillVirtual) {
          const split = await tennisThreeBuckets.splitFullToThreeBuckets(full);
          refreshed = { ...full, bucketSplit: split };
        }
      } catch (e2) {
        console.warn('[tennis-monitor/data-source] fallback split failed:', e2.message);
      }
    }
    const days = tennisDocks500.listDays();
    const date = await tennisDocks500.getSelectedDate();
    const split = refreshed?.bucketSplit || null;
    const sim = refreshed?.virtualSim || null;
    const realMsg = split
      ? `已切换真实源并刷新三桶 · 盘前${split.prematch ?? '?'} / 盘中${split.inplay ?? '?'} / 盘后${split.settled ?? '?'}`
      : (refreshError
        ? `已切换真实源，但刷新失败（${refreshError.message || 'unknown'}）；请执行真实采集后再看盘前/盘中/盘后`
        : '已切换真实源；请执行真实采集以写入盘前/盘中/盘后');
    res.json({
      ok: true,
      source: next,
      label: tennisDataSource.label(next),
      api_available: allsports.isConfigured(),
      docks500_available: days.length > 0,
      docks500: { days, date, available: days.length > 0, split, sim },
      redis_read: true,
      redis_upstream: refreshed?.upstream || next,
      redis_fetched_at: refreshed?.fetched_at || null,
      events: refreshed?.events ?? null,
      message:
        next === 'docks500'
          ? `已切换虚拟·txt（${require('path').basename(tennisDocks500.resolveTxtPath())}）· ${date} · 盘前${split?.prematch ?? sim?.prematch ?? '?'} / 盘中${split?.inplay ?? sim?.inplay ?? '?'} / 盘后${split?.settled ?? sim?.settled ?? '?'}`
          : realMsg,
    });
  } catch (err) {
    console.error('[tennis-monitor/data-source]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'update data source failed' });
  }
});

router.get('/engines', async (_req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const cfg = await tennisEngines.getConfig();
    res.json({ ok: true, ...cfg });
  } catch (err) {
    console.error('[tennis-monitor/engines]', err);
    res.status(500).json({ ok: false, error: err.message || 'engines failed' });
  }
});

router.get('/engines/betting-logs', async (req, res) => {
  try {
    const tennisBettingExecLog = require('../services/tennisBettingExecLog');
    const data = await tennisBettingExecLog.list({
      limit: req.query.limit,
      strategyKey: req.query.strategyKey,
      type: req.query.type,
      bucket: req.query.bucket,
    });
    res.json(data);
  } catch (err) {
    console.error('[tennis-monitor/engines/betting-logs]', err);
    res.status(500).json({ ok: false, error: err.message || 'betting logs failed' });
  }
});

router.post('/engines/betting-logs/clear', async (_req, res) => {
  try {
    const tennisBettingExecLog = require('../services/tennisBettingExecLog');
    const data = await tennisBettingExecLog.clear();
    res.json(data);
  } catch (err) {
    console.error('[tennis-monitor/engines/betting-logs/clear]', err);
    res.status(500).json({ ok: false, error: err.message || 'clear betting logs failed' });
  }
});

router.get('/engines/betting-orders', async (req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const tradeRecords = require('../services/tradeRecords');
    const cfg = await tennisEngines.getConfig();
    const uid = Number(cfg.betting?.userId) || 0;
    const limit = Number(req.query.limit || 100);
    const offset = Number(req.query.offset || 0);
    const data = await tradeRecords.listTradeRecords(uid || null, {
      product: 'tennis-family',
      limit,
      offset,
      anyUser: !uid,
    });
    res.json({
      ...data,
      userId: uid || null,
      userAccount: cfg.betting?.userAccount || null,
    });
  } catch (err) {
    console.error('[tennis-monitor/engines/betting-orders]', err);
    res.status(500).json({ ok: false, error: err.message || 'betting orders failed' });
  }
});

router.delete('/engines/betting-orders/:id', async (req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const tradeRecords = require('../services/tradeRecords');
    const cfg = await tennisEngines.getConfig();
    const uid = Number(cfg.betting?.userId) || 0;
    const data = await tradeRecords.deleteTradeRecord(req.params.id, {
      userId: uid || null,
      tennisOnly: true,
    });
    if (!data.deleted) return res.status(404).json({ ok: false, error: '订单不存在' });
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[tennis-monitor/engines/betting-orders/delete]', err);
    res.status(500).json({ ok: false, error: err.message || '删除订单失败' });
  }
});

router.post('/engines/betting-orders/clear', async (_req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const tradeRecords = require('../services/tradeRecords');
    const cfg = await tennisEngines.getConfig();
    const uid = Number(cfg.betting?.userId) || 0;
    const data = await tradeRecords.clearTradeRecords({
      userId: uid || null,
      product: 'tennis-family',
      anyUser: !uid,
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[tennis-monitor/engines/betting-orders/clear]', err);
    res.status(500).json({ ok: false, error: err.message || '清空订单失败' });
  }
});

router.post('/engines/betting-mark-placed', async (req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const tennisBettingEngine = require('../services/tennisBettingEngine');
    const cfg = await tennisEngines.getConfig();
    const uid = Number(req.body?.userId || cfg.betting?.userId) || 0;
    if (!uid) {
      return res.status(400).json({ ok: false, error: '未配置投注用户' });
    }
    const data = await tennisBettingEngine.markPlacedFromOrders({
      userId: uid,
      product: req.body?.product,
      strategyKey: req.body?.strategyKey,
      orders: Array.isArray(req.body?.orders) ? req.body.orders : [],
    });
    if (!data.ok) return res.status(400).json(data);
    res.json(data);
  } catch (err) {
    console.error('[tennis-monitor/engines/betting-mark-placed]', err);
    res.status(err.code === 'STATE_REDIS' ? 503 : 500).json({
      ok: false,
      error: err.message || 'mark placed failed',
    });
  }
});

router.post('/engines/betting-mark-sold', async (req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const tennisBettingEngine = require('../services/tennisBettingEngine');
    const cfg = await tennisEngines.getConfig();
    const uid = Number(req.body?.userId || cfg.betting?.userId) || 0;
    if (!uid) {
      return res.status(400).json({ ok: false, error: '未配置投注用户' });
    }
    const data = await tennisBettingEngine.markSoldFromOrders({
      userId: uid,
      product: req.body?.product,
      strategyKey: req.body?.strategyKey,
      orders: Array.isArray(req.body?.orders) ? req.body.orders : [],
    });
    if (!data.ok) return res.status(400).json(data);
    res.json(data);
  } catch (err) {
    console.error('[tennis-monitor/engines/betting-mark-sold]', err);
    res.status(err.code === 'STATE_REDIS' ? 503 : 500).json({
      ok: false,
      error: err.message || 'mark sold failed',
    });
  }
});

router.post('/engines', async (req, res) => {
  try {
    const tennisEngines = require('../services/tennisEngines');
    const cfg = await tennisEngines.setConfig(req.body || {});
    res.json({ ok: true, ...cfg });
  } catch (err) {
    console.error('[tennis-monitor/engines]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'update engines failed' });
  }
});

router.post('/engines/split-buckets', async (req, res) => {
  try {
    const engineServices = require('../services/engineServicesClient');
    const data = await engineServices.collectFull({
      sport: 'tennis',
      top100: false,
      ...(req.body || {}),
    });
    res.json({ ok: true, ...data, service: 'collect' });
  } catch (err) {
    console.error('[tennis-monitor/split-buckets]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'split failed' });
  }
});

/** 用采集数据虚拟造盘前 / 盘中并写入三桶 */
router.post('/engines/seed-virtual', async (req, res) => {
  try {
    const tennisThreeBuckets = require('../services/tennisThreeBuckets');
    const prematchCount = req.body?.prematchCount;
    const inplayCount = req.body?.inplayCount;
    const date = req.body?.date;
    const forceRebuild = !!req.body?.forceRebuild;
    const r = await tennisThreeBuckets.seedVirtualPrematchInplay({
      prematchCount,
      inplayCount,
      date,
      forceRebuild,
    });
    if (!r.ok) {
      return res.status(r.error?.includes('Redis') ? 503 : 400).json(r);
    }
    res.json(r);
  } catch (err) {
    console.error('[tennis-monitor/seed-virtual]', err);
    res.status(500).json({ ok: false, error: err.message || 'seed virtual failed' });
  }
});

/** 虚拟日编辑：日期列表 */
router.get('/docks500/days', async (_req, res) => {
  try {
    const tennisDocks500 = require('../services/tennisDocks500');
    tennisDocks500.ensureByDayFromTxt();
    const days = tennisDocks500.listDays();
    const date = await tennisDocks500.getSelectedDate();
    res.json({ ok: true, days, date });
  } catch (err) {
    console.error('[tennis-monitor/docks500/days]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'list days failed' });
  }
});

/** 虚拟日编辑：扁平场次 */
router.get('/docks500/day/:date', async (req, res) => {
  try {
    const tennisDocks500 = require('../services/tennisDocks500');
    const view = tennisDocks500.getDayEditorView(req.params.date);
    res.json({ ok: true, ...view });
  } catch (err) {
    console.error('[tennis-monitor/docks500/day]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'load day failed' });
  }
});

/** 虚拟日编辑：单场补丁（落盘并锁定阶段） */
router.put('/docks500/day/:date/match/:id', async (req, res) => {
  try {
    const tennisDocks500 = require('../services/tennisDocks500');
    const saved = tennisDocks500.applyEventPatch(req.params.date, req.params.id, req.body || {});
    const view = tennisDocks500.getDayEditorView(req.params.date);
    res.json({
      ok: true,
      phasesLocked: true,
      matchCount: saved?.meta?.matchCount ?? view.matches?.length,
      match: view.matches.find((m) => String(m.id) === String(req.params.id)) || null,
      virtualSim: view.virtualSim,
    });
  } catch (err) {
    console.error('[tennis-monitor/docks500/patch]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'patch failed' });
  }
});

/** 虚拟日编辑：清空本日全部场次 */
router.post('/docks500/day/:date/clear', async (req, res) => {
  try {
    const tennisDocks500 = require('../services/tennisDocks500');
    tennisDocks500.clearDayEvents(req.params.date);
    const view = tennisDocks500.getDayEditorView(req.params.date);
    res.json({
      ok: true,
      date: req.params.date,
      phasesLocked: true,
      matchCount: 0,
      matches: view.matches || [],
      virtualSim: view.virtualSim,
      message: `已清空 ${req.params.date}`,
    });
  } catch (err) {
    console.error('[tennis-monitor/docks500/clear]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'clear failed' });
  }
});

/** 虚拟日编辑：新增一场 */
router.post('/docks500/day/:date/match', async (req, res) => {
  try {
    const tennisDocks500 = require('../services/tennisDocks500');
    const { eventId } = tennisDocks500.addDayEvent(req.params.date, req.body || {});
    const view = tennisDocks500.getDayEditorView(req.params.date);
    res.json({
      ok: true,
      date: req.params.date,
      phasesLocked: true,
      eventId,
      match: view.matches.find((m) => String(m.id) === String(eventId)) || null,
      matches: view.matches,
      virtualSim: view.virtualSim,
      matchCount: view.matches?.length ?? 0,
    });
  } catch (err) {
    console.error('[tennis-monitor/docks500/add]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'add failed' });
  }
});

/** 虚拟日编辑：解锁并重新自动拆桶 */
router.post('/docks500/day/:date/unlock-resim', async (req, res) => {
  try {
    const tennisDocks500 = require('../services/tennisDocks500');
    const saved = tennisDocks500.unlockAndResimDay(req.params.date, {
      prematchCount: req.body?.prematchCount,
      inplayCount: req.body?.inplayCount,
    });
    res.json({
      ok: true,
      date: req.params.date,
      phasesLocked: false,
      meta: saved.meta,
      virtualSim: saved.bundle?.virtualSim || null,
      matches: tennisDocks500.flattenEvents(saved),
    });
  } catch (err) {
    console.error('[tennis-monitor/docks500/unlock-resim]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'resim failed' });
  }
});

/** 虚拟日编辑：选中日期并写回 Redis 三桶 */
router.post('/docks500/day/:date/apply', async (req, res) => {
  try {
    const tennisDocks500 = require('../services/tennisDocks500');
    const tennisDataSource = require('../services/tennisDataSource');
    const tennisFromMonitor = require('../services/tennisFromMonitor');
    const date = await tennisDocks500.setSelectedDate(req.params.date);
    await tennisDataSource.set('docks500');
    const refreshed = await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: false });
    res.json({
      ok: true,
      date,
      source: 'docks500',
      events: refreshed?.events ?? null,
      split: refreshed?.bucketSplit || null,
      sim: refreshed?.virtualSim || null,
      message: refreshed?.message || `已应用虚拟日 ${date}`,
    });
  } catch (err) {
    console.error('[tennis-monitor/docks500/apply]', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'apply failed' });
  }
});

module.exports = router;
