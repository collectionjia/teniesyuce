/**
 * 五引擎 HTTP 客户端（collect / rules / betting / stop-loss）
 * 页面与 admin API 经此转发，不直连内嵌 runner。
 */
function baseUrl(name) {
  const map = {
    collect: process.env.COLLECT_URL,
    rules: process.env.RULES_URL,
    betting: process.env.BETTING_URL,
    stopLoss: process.env.STOP_LOSS_URL,
  };
  return String(map[name] || '').trim().replace(/\/$/, '') || null;
}

function authHeaders() {
  const token = (process.env.INTERNAL_SERVICE_TOKEN || '').trim();
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function request(service, method, path, body) {
  const base = baseUrl(service);
  if (!base) {
    const err = new Error(`${service} URL not configured (set ${service.toUpperCase()}_URL)`);
    err.status = 503;
    throw err;
  }
  const init = { method, headers: authHeaders() };
  if (body != null && method !== 'GET') init.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `${service} HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function collectFull(body = {}) {
  return request('collect', 'POST', '/internal/collect/full', body);
}

async function collectPartial(body = {}) {
  return request('collect', 'POST', '/internal/collect/partial', body);
}

async function collectStatus(query = {}) {
  const qs = new URLSearchParams(query).toString();
  return request('collect', 'GET', `/internal/collect/status${qs ? `?${qs}` : ''}`);
}

async function rulesEvaluate(body = {}) {
  return request('rules', 'POST', '/internal/rules/evaluate', body);
}

async function rulesMatched(query = {}) {
  const qs = new URLSearchParams(query).toString();
  return request('rules', 'GET', `/internal/rules/matched${qs ? `?${qs}` : ''}`);
}

async function bettingScan(body = {}) {
  return request('betting', 'POST', '/internal/betting/scan', body);
}

async function bettingOpenOrders() {
  return request('betting', 'GET', '/internal/betting/orders/open');
}

async function stopLossScan(body = {}) {
  return request('stopLoss', 'POST', '/internal/stop-loss/scan', body);
}

async function stopLossStatus() {
  return request('stopLoss', 'GET', '/internal/stop-loss/status');
}

async function serviceHealth(service) {
  const base = baseUrl(service);
  if (!base) {
    return { ok: false, service, error: 'URL not configured' };
  }
  try {
    const res = await fetch(`${base}/health`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, service, error: data.error || `HTTP ${res.status}` };
    }
    return { ...data, service: data.service || service };
  } catch (e) {
    return { ok: false, service, error: e.message || 'unreachable' };
  }
}

async function schedulerHealth() {
  const schedulerClient = require('./schedulerClient');
  const url = schedulerClient.baseUrl?.();
  if (!url) {
    try {
      const st = await schedulerClient.status();
      return { ok: true, service: 'scheduler', mode: 'embedded-status', ...st };
    } catch (e) {
      return { ok: false, service: 'scheduler', error: e.message };
    }
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, service: 'scheduler', error: data.error || `HTTP ${res.status}` };
    }
    return { ...data, service: 'scheduler' };
  } catch (e) {
    return { ok: false, service: 'scheduler', error: e.message || 'unreachable' };
  }
}

async function fetchOverview() {
  const [collect, rules, betting, stopLoss, scheduler] = await Promise.all([
    serviceHealth('collect'),
    serviceHealth('rules'),
    serviceHealth('betting'),
    serviceHealth('stopLoss'),
    schedulerHealth(),
  ]);
  return {
    ok: [collect, rules, betting, stopLoss, scheduler].every((s) => s.ok !== false),
    at: new Date().toISOString(),
    services: { collect, rules, betting, stopLoss, scheduler },
    urls: {
      collect: baseUrl('collect'),
      rules: baseUrl('rules'),
      betting: baseUrl('betting'),
      stopLoss: baseUrl('stopLoss'),
      scheduler: require('./schedulerClient').baseUrl?.() || null,
    },
  };
}

module.exports = {
  baseUrl,
  collectFull,
  collectPartial,
  collectStatus,
  rulesEvaluate,
  rulesMatched,
  bettingScan,
  bettingOpenOrders,
  stopLossScan,
  stopLossStatus,
  serviceHealth,
  schedulerHealth,
  fetchOverview,
};
