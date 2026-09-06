const express = require('express');
const { auth } = require('../middleware/auth');
const tennisLiveCache = require('../services/tennisLiveCache');
const tennisLiveFromMonitor = require('../services/tennisLiveFromMonitor');
const {
  passesLiveTier,
  matchLiveMetrics,
  tierLabel,
  isLiveMatch,
  allEventsFromBundle,
} = require('../services/tennisLiveFilter');

const router = express.Router();

const MONITOR_BASE = (process.env.SOFA_MONITOR_URL || 'http://172.17.0.1:9004').replace(/\/$/, '');
const MONITOR_TOKEN = (process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026').trim();

async function monitorFetch(pathname, timeoutMs = 10000) {
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

function filterPreviewMatches(bundle, tier = 'all') {
  const rankings = bundle?.rankingsByPlayer || {};
  const all = allEventsFromBundle(bundle);
  return all.filter((m) => isLiveMatch(m) && passesLiveTier(m, tier, rankings));
}

router.use(auth(['admin']));

function livePlayerIds(bundle) {
  const rankings = bundle?.rankingsByPlayer || {};
  const ids = new Set();
  for (const m of filterPreviewMatches(bundle, 'all')) {
    for (const side of [m.homePlayer, m.awayPlayer]) {
      const id = side?.id ?? side?.teamId;
      if (id != null) ids.add(String(id));
    }
    const homeName = m.home || m.homePlayer?.name;
    const awayName = m.away || m.awayPlayer?.name;
    if (homeName) ids.add(`name:${String(homeName).toLowerCase()}`);
    if (awayName) ids.add(`name:${String(awayName).toLowerCase()}`);
  }
  return { ids, rankings };
}

function enrichPlayers(players, bundle) {
  const { ids } = livePlayerIds(bundle);
  return (players || []).map((p) => {
    const idKey = p.id != null ? String(p.id) : '';
    const nameKey = p.name ? `name:${String(p.name).toLowerCase()}` : '';
    const inLive = (idKey && ids.has(idKey)) || (nameKey && ids.has(nameKey));
    const liveMatches = (p.matches || []).filter((m) => {
      const st = String(m.status || m.statusType || '').toLowerCase();
      return st.includes('live') || st.includes('progress') || st.includes('set') || st === 'inprogress';
    });
    return {
      ...p,
      inLive: inLive || liveMatches.length > 0,
      liveMatchCount: liveMatches.length,
    };
  });
}

async function fetchTop100Players(refresh = false) {
  if (refresh) {
    const snap = await monitorFetch('/bundle/top100', 120000);
    const top = snap?.top100 || {};
    return {
      ok: true,
      date: snap?.date,
      fetched_at: snap?.fetched_at,
      atp: top.atp || [],
      wta: top.wta || [],
      summary: top.summary || {},
      source: 'bundle/top100',
    };
  }
  let body = await monitorFetch('/top100').catch(() => null);
  if (body?.ok && (body.atp?.length || body.wta?.length)) {
    return { ...body, source: 'top100' };
  }
  const snap = await monitorFetch('/bundle/top100', 120000).catch(() => null);
  if (snap?.top100) {
    return {
      ok: true,
      date: snap.date,
      fetched_at: snap.fetched_at,
      atp: snap.top100.atp || [],
      wta: snap.top100.wta || [],
      summary: snap.top100.summary || {},
      source: 'bundle/top100',
    };
  }
  return body || { ok: false, error: '暂无 Top100 排名数据' };
}

router.get('/players', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '0') === '1';
    let body = await fetchTop100Players(refresh);
    if (!body?.ok) {
      return res.status(503).json(body || { ok: false, error: 'Top100 不可用' });
    }
    const bundle = await tennisLiveCache.getBundle();
    res.json({
      ok: true,
      date: body.date,
      fetched_at: body.fetched_at,
      summary: body.summary || {},
      atp: enrichPlayers(body.atp, bundle),
      wta: enrichPlayers(body.wta, bundle),
      source: body.source,
    });
  } catch (err) {
    console.error('[tennis-live-monitor/players]', err);
    res.status(500).json({ ok: false, error: err.message || 'players failed' });
  }
});

router.get('/status', async (_req, res) => {
  try {
    const [livePoll, bundle] = await Promise.all([
      monitorFetch('/live', 8000).catch(() => null),
      tennisLiveCache.getBundle(),
    ]);
    const rankings = bundle?.rankingsByPlayer || {};
    const tierCounts = { all: 0, t10: 0, t20: 0, t50: 0, t100: 0 };
    if (bundle) {
      for (const m of filterPreviewMatches(bundle, 'all')) {
        tierCounts.all += 1;
        const metrics = matchLiveMetrics(m, rankings);
        if (!metrics.ready) continue;
        const label = tierLabel(metrics.strongRank);
        if (label === 'Top10+20') tierCounts.t10 += 1;
        else if (label === 'Top20+30') tierCounts.t20 += 1;
        else if (label === 'Top50+50') tierCounts.t50 += 1;
        else if (label === 'Top100+150') tierCounts.t100 += 1;
      }
    }
    res.json({
      ok: true,
      poll_interval_sec: Number(livePoll?.interval_sec || process.env.LIVE_POLL_INTERVAL_SEC || 120),
      live_poll: livePoll?.last || null,
      live_running: !!livePoll?.running,
      cache: bundle
        ? {
            date: bundle.date,
            fetched_at: bundle.fetched_at,
            events: bundle.events,
            live: bundle.live?.eventCount ?? 0,
            message: bundle.message,
          }
        : null,
      tier_counts: tierCounts,
    });
  } catch (err) {
    console.error('[tennis-live-monitor/status]', err);
    res.status(500).json({ ok: false, error: err.message || 'status failed' });
  }
});

router.get('/preview', async (req, res) => {
  try {
    const tier = String(req.query.tier || 'all');
    let bundle = await tennisLiveCache.getBundle();
    if (!bundle) {
      bundle = await tennisLiveFromMonitor.refreshLiveBundleFromMonitor();
    }
    const rankings = bundle?.rankingsByPlayer || {};
    const matches = filterPreviewMatches(bundle, tier).map((m) => {
      const metrics = matchLiveMetrics(m, rankings);
      return {
        id: m.id,
        home: m.home || m.homePlayer?.name,
        away: m.away || m.awayPlayer?.name,
        tour: m.tour,
        status: m.status,
        scoreText: m.scoreText,
        tier: tierLabel(metrics.strongRank),
        gap: metrics.gap,
        homeR: metrics.homeR,
        awayR: metrics.awayR,
      };
    });
    res.json({
      ok: true,
      tier,
      fetched_at: bundle?.fetched_at,
      count: matches.length,
      matches,
    });
  } catch (err) {
    console.error('[tennis-live-monitor/preview]', err);
    res.status(500).json({ ok: false, error: err.message || 'preview failed' });
  }
});

router.post('/refresh', async (_req, res) => {
  try {
    const bundle = await tennisLiveFromMonitor.refreshLiveBundleFromMonitor();
    res.json({
      ok: true,
      date: bundle.date,
      events: bundle.events,
      live: bundle.live?.eventCount ?? 0,
      fetched_at: bundle.fetched_at,
    });
  } catch (err) {
    console.error('[tennis-live-monitor/refresh]', err);
    res.status(500).json({ ok: false, error: err.message || 'refresh failed' });
  }
});

module.exports = router;
