const MONITOR_BASE = (process.env.SOFA_MONITOR_URL || 'http://172.17.0.1:9004').replace(/\/$/, '');
const MONITOR_TOKEN = (process.env.SOFA_MONITOR_TOKEN || 'sofascore-monitor-2026').trim();

async function monitorJson(pathname, { method = 'GET', query, timeoutMs = 15000 } = {}) {
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
    signal: AbortSignal.timeout(timeoutMs),
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

function summaryFromBoard(top100 = {}) {
  const atp = top100.atp || [];
  const wta = top100.wta || [];
  const atpMatches = atp.reduce((n, p) => n + (p.matches || []).length, 0);
  const wtaMatches = wta.reduce((n, p) => n + (p.matches || []).length, 0);
  return {
    ...(top100.summary || {}),
    atp_players: atp.length,
    wta_players: wta.length,
    atp_matches: atpMatches,
    wta_matches: wtaMatches,
    total_matches: top100.summary?.total_matches ?? atpMatches + wtaMatches,
  };
}

async function fetchTop100Payload(refresh = false) {
  if (refresh) {
    const bundle = await monitorJson('/top100', { query: { refresh: 1 }, timeoutMs: 30000 });
    if (bundle.status === 200 && bundle.body?.ok) {
      return { status: 200, body: { ...bundle.body, source: 'top100' } };
    }
    const snap = await monitorJson('/bundle/top100', { timeoutMs: 120000 });
    if (snap.status === 200 && snap.body?.top100) {
      const top = snap.body.top100;
      return {
        status: 200,
        body: {
          ok: true,
          loading: false,
          date: snap.body.date,
          fetched_at: snap.body.fetched_at,
          atp: top.atp || [],
          wta: top.wta || [],
          summary: summaryFromBoard(top),
          source: 'bundle/top100',
        },
      };
    }
    return bundle.status !== 404 ? bundle : snap;
  }

  let result = await monitorJson('/top100', { timeoutMs: 30000 });
  if (result.status === 200 && result.body?.ok && (result.body.atp?.length || result.body.wta?.length || result.body.loading)) {
    return { status: 200, body: { ...result.body, source: 'top100' } };
  }
  if (result.status === 200 && result.body?.loading) {
    return { status: 200, body: { ...result.body, source: 'top100' } };
  }

  const snap = await monitorJson('/bundle/top100', { timeoutMs: 120000 }).catch(() => ({ status: 404, body: null }));
  if (snap.status === 200 && snap.body?.top100) {
    const top = snap.body.top100;
    return {
      status: 200,
      body: {
        ok: true,
        loading: false,
        date: snap.body.date,
        fetched_at: snap.body.fetched_at,
        atp: top.atp || [],
        wta: top.wta || [],
        summary: summaryFromBoard(top),
        source: 'bundle/top100',
      },
    };
  }

  if (result.status === 404) {
    return {
      status: 503,
      body: {
        ok: false,
        error: '监控服务未升级 Top100 接口，请更新 scripts/sofascore-monitor 并重启 sofascore-monitor',
      },
    };
  }
  return result;
}

async function triggerTop100Collect() {
  const post = await monitorJson('/top100/collect', { method: 'POST', timeoutMs: 15000 });
  if (post.status !== 404) return post;

  const snap = await monitorJson('/bundle/top100', { timeoutMs: 120000 });
  if (snap.status === 200 && snap.body?.top100) {
    const top = snap.body.top100;
    return {
      status: 200,
      body: {
        ok: true,
        message: 'top100 collect finished (sync bundle/top100)',
        atp: top.atp || [],
        wta: top.wta || [],
        summary: summaryFromBoard(top),
        date: snap.body.date,
        fetched_at: snap.body.fetched_at,
        source: 'bundle/top100',
      },
    };
  }
  return post;
}

module.exports = {
  monitorJson,
  fetchTop100Payload,
  triggerTop100Collect,
};
