const express = require('express');
const { auth } = require('../middleware/auth');
const {
  monitorJson,
  fetchTop100Payload,
  triggerTop100Collect,
} = require('../services/sofaMonitorTop100');

const router = express.Router();

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

function sendProxy(res, result) {
  res.status(result.status).json(result.body);
}

function scheduleLiveRedisRefresh() {
  const deadline = Date.now() + 180000;

  const poll = async () => {
    try {
      const { body: statusBody } = await monitorJson('/status', { timeoutMs: 10000 });
      const top100Running = !!statusBody?.top100_collect?.running;
      const liveRunning = !!statusBody?.live_poll?.running;
      if (top100Running || liveRunning) {
        if (Date.now() < deadline) setTimeout(poll, 3000);
        return;
      }
      try {
        const tennisLiveFromMonitor = require('../services/tennisLiveFromMonitor');
        await tennisLiveFromMonitor.refreshLiveBundleFromMonitor();
        console.log('[tennis-live-scraper] redis-live refreshed');
      } catch (err) {
        console.error('[tennis-live-scraper] redis-live refresh:', err.message);
      }
    } catch (err) {
      console.error('[tennis-live-scraper] poll:', err.message);
      if (Date.now() < deadline) setTimeout(poll, 5000);
    }
  };

  setTimeout(poll, 5000);
}

router.use(auth(['admin']));

router.get('/status', async (_req, res) => {
  try {
    sendProxy(res, await monitorJson('/status'));
  } catch (err) {
    console.error('[tennis-live-scraper/status]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/top100', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '0') === '1';
    sendProxy(res, await fetchTop100Payload(refresh));
  } catch (err) {
    console.error('[tennis-live-scraper/top100]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.post('/top100/collect', async (_req, res) => {
  try {
    const result = await triggerTop100Collect();
    sendProxy(res, result);
    if (result.status >= 200 && result.status < 300) scheduleLiveRedisRefresh();
  } catch (err) {
    console.error('[tennis-live-scraper/top100/collect]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/live', async (_req, res) => {
  try {
    sendProxy(res, await monitorJson('/live'));
  } catch (err) {
    console.error('[tennis-live-scraper/live]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.post('/live/collect', async (_req, res) => {
  try {
    sendProxy(res, await monitorJson('/live/collect', { method: 'POST' }));
    scheduleLiveRedisRefresh();
  } catch (err) {
    console.error('[tennis-live-scraper/live/collect]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

router.get('/logs', async (req, res) => {
  try {
    sendProxy(
      res,
      await monitorJson('/logs', {
        query: { lines: req.query.lines || '120' },
      }),
    );
  } catch (err) {
    console.error('[tennis-live-scraper/logs]', err);
    res.status(502).json({ ok: false, error: friendlyMonitorError(err) });
  }
});

module.exports = router;
