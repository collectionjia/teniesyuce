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

async function collectFullLocal(body = {}) {
  const top100 = body.top100 !== false && body.all !== true;
  const tennisDataSource = require('./tennisDataSource');
  const pref = await tennisDataSource.get();
  if (top100) {
    if (pref === 'docks500') {
      return { skipped: true, message: '虚拟(txt)模式跳过官网 Top100 采集' };
    }
    const tennisCollectRunner = require('./tennisCollectRunner');
    if (tennisCollectRunner.isRunning()) {
      return { skipped: true, message: 'tennisFullCollect already running' };
    }
    const started = await tennisCollectRunner.startCollect({
      matchDate: body.matchDate || body.date || null,
      top100: true,
      wait: true,
      trigger: 'engine-collect.top100',
    });
    if (!started.ok) {
      const err = new Error(started.error || 'collect.top100 start failed');
      err.status = started.status || 500;
      throw err;
    }
    if (started.last?.status === 'failed') {
      const err = new Error(started.error || started.last?.error || 'collect.top100 failed');
      err.status = 500;
      throw err;
    }
    return {
      message: `collect.top100 done · ${started.last?.total_events ?? 0} events`,
      metrics: started.last || {},
    };
  }
  const tennisThreeBuckets = require('./tennisThreeBuckets');
  if (pref === 'docks500') {
    const r = await tennisThreeBuckets.seedVirtualPrematchInplay({
      txtName: body.txtName || '2026_500.txt',
      prematchCount: body.prematchCount,
      inplayCount: body.inplayCount,
    });
    if (!r.ok) throw new Error(r.error || 'virtual txt seed failed');
    return { message: r.message || 'collect.full virtual txt done', metrics: r };
  }
  const split = await tennisThreeBuckets.splitFullToThreeBuckets();
  const migP = await tennisThreeBuckets.migratePrematchByStartTime();
  const migI = await tennisThreeBuckets.migrateInplayEnded();
  return {
    message: 'collect.full done',
    metrics: { split, migratePrematch: migP, migrateInplay: migI },
  };
}

async function collectFull(body = {}) {
  if (!baseUrl('collect')) return collectFullLocal(body);
  return request('collect', 'POST', '/internal/collect/full', body);
}

async function collectPartialLocal(body = {}) {
  const tennisDataSource = require('./tennisDataSource');
  if ((await tennisDataSource.get()) === 'docks500') {
    return { skipped: true, message: '虚拟(txt)模式跳过 tick / Polymarket 采集' };
  }
  const tennisInplayTick = require('./tennisInplayTick');
  const jobType = String(body.jobType || '').trim();
  const r = jobType === 'collect.top100_hf'
    ? await tennisInplayTick.refreshInplayOddsTick()
    : await tennisInplayTick.runInplayTick({
        skipBetting: body.skipBetting !== false,
      });
  if (r && typeof r === 'object') {
    return {
      ...r,
      message: r.ok === false ? (r.reason || 'inplay tick failed') : 'inplay partial done (local)',
      local: true,
    };
  }
  return r;
}

async function collectPartial(body = {}) {
  if (!baseUrl('collect')) return collectPartialLocal(body);
  try {
    return await request('collect', 'POST', '/internal/collect/partial', body);
  } catch (e) {
    // 采集服务挂掉 / 连不上时回退本机 tick（Node fetch 常无 status，只带 message/cause）
    const code = e?.code || e?.cause?.code || e?.cause?.cause?.code;
    const msg = String(e?.message || e || '');
    const unreachable =
      e?.status === 503
      || e?.status === 502
      || code === 'ECONNREFUSED'
      || code === 'ENOTFOUND'
      || code === 'ETIMEDOUT'
      || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|socket/i.test(msg);
    if (unreachable) {
      console.warn('[engines] collect partial unreachable, fallback local:', msg);
      return collectPartialLocal(body);
    }
    throw e;
  }
}

async function collectStatus(query = {}) {
  if (!baseUrl('collect')) {
    const tennisCollectRunner = require('./tennisCollectRunner');
    const st = tennisCollectRunner.statusPayload();
    return {
      ok: true,
      sport: query.sport || 'tennis',
      running: { full: tennisCollectRunner.isRunning(), live: tennisCollectRunner.isLiveRunning() },
      collect: st,
    };
  }
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
