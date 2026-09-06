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

/** 等 9004 采集结束后再把 bundle 刷进 Redis */
function scheduleRedisRefreshAfterCollect() {
  const tennisFromMonitor = require('../services/tennisFromMonitor');
  const deadline = Date.now() + 120000;

  const poll = async () => {
    try {
      const { body } = await monitorFetch('/status', { timeoutMs: 10000 });
      if (body?.running) {
        if (Date.now() < deadline) setTimeout(poll, 3000);
        return;
      }
      await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
      console.log('[sofa-monitor] redis refreshed after collect');
      try {
        const tennisLiveFromMonitor = require('../services/tennisLiveFromMonitor');
        await tennisLiveFromMonitor.refreshLiveBundleFromMonitor();
        console.log('[sofa-monitor] redis-live refreshed after collect');
      } catch (err) {
        console.error('[sofa-monitor] redis-live refresh:', err.message);
      }
    } catch (err) {
      console.error('[sofa-monitor] redis refresh:', err.message);
      if (Date.now() < deadline) setTimeout(poll, 5000);
      else tennisFromMonitor.kickRefreshBackground();
    }
  };

  setTimeout(poll, 5000);
}

router.use(auth(['admin']));

router.get('/status', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/status'));
  } catch (err) {
    console.error('[sofa-monitor/status]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
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
    console.error('[sofa-monitor/top20]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/logs', async (req, res) => {
  try {
    sendProxy(
      res,
      await monitorFetch('/logs', {
        query: { lines: req.query.lines || '120' },
      }),
    );
  } catch (err) {
    console.error('[sofa-monitor/logs]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.post('/collect', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/collect', { method: 'POST' }));
    scheduleRedisRefreshAfterCollect();
  } catch (err) {
    console.error('[sofa-monitor/collect]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/live', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/live'));
  } catch (err) {
    console.error('[sofa-monitor/live]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/bundle', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/bundle', { timeoutMs: 30000 }));
  } catch (err) {
    console.error('[sofa-monitor/bundle]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.post('/live/collect', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/live/collect', { method: 'POST' }));
    scheduleRedisRefreshAfterCollect();
  } catch (err) {
    console.error('[sofa-monitor/live/collect]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/schedule', async (_req, res) => {
  try {
    sendProxy(res, await monitorFetch('/schedule'));
  } catch (err) {
    console.error('[sofa-monitor/schedule]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.post('/schedule', async (req, res) => {
  try {
    const intervalHours = Number(req.body?.interval_hours);
    const url = new URL('/schedule', `${MONITOR_BASE}/`);
    const proxyRes = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MONITOR_TOKEN}`,
      },
      body: JSON.stringify({ interval_hours: intervalHours }),
      signal: AbortSignal.timeout(MONITOR_FETCH_TIMEOUT_MS),
    });
    const text = await proxyRes.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, error: text || `HTTP ${proxyRes.status}` };
    }
    res.status(proxyRes.status).json(body);
  } catch (err) {
    console.error('[sofa-monitor/schedule]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

module.exports = router;
