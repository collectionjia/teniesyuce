/**
 * 通过 HTTP 调用各引擎服务 internal API
 */
function serviceBase(name) {
  const map = {
    collect: process.env.COLLECT_URL,
    rules: process.env.RULES_URL,
    betting: process.env.BETTING_URL,
    stopLoss: process.env.STOP_LOSS_URL,
  };
  return String(map[name] || '').replace(/\/$/, '');
}

function authHeaders() {
  const token = (process.env.INTERNAL_SERVICE_TOKEN || '').trim();
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function postJson(baseUrl, path, body) {
  if (!baseUrl) {
    return { skipped: true, message: `service URL not configured for ${path}` };
  }
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `invalid JSON from ${url}` };
  }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status} ${url}`);
  }
  if (data?.skipped) {
    return { skipped: true, message: data.message || 'skipped', metrics: data };
  }
  return {
    message: data.message || 'ok',
    metrics: data.metrics || data,
  };
}

function buildBody(job, params) {
  const p = { ...(params || {}) };
  const sport = p.sport || 'tennis';
  switch (job.jobType) {
    case 'collect.full':
      return { sport, ...p };
    case 'collect.top100':
      return { sport, top100: true, ...p };
    case 'collect.inplay_tick':
    case 'collect.top100_hf':
      return { sport, ...p };
    case 'condition.query':
      return {
        bucket: p.bucket || 'prematch',
        groupIndex: p.groupIndex,
        groupName: p.groupName,
        sport,
      };
    case 'bet.scan':
      return {
        bucket: p.bucket || null,
        groupIndex: p.groupIndex,
        amountUsd: p.amountUsd,
        userId: p.userId,
        sport,
      };
    case 'bet.stop_loss':
      return {
        bucket: p.bucket || null,
        groupIndex: p.groupIndex,
        sport,
      };
    default:
      return p;
  }
}

async function executeJobTypeHttp(job, params = {}) {
  const body = buildBody(job, params);
  const sport = body.sport || 'tennis';

  switch (job.jobType) {
    case 'collect.full':
    case 'collect.top100':
      return postJson(serviceBase('collect'), '/internal/collect/full', body);
    case 'collect.inplay_tick':
    case 'collect.top100_hf':
      return postJson(serviceBase('collect'), '/internal/collect/partial', body);
    case 'condition.query':
      return postJson(serviceBase('rules'), '/internal/rules/evaluate', body);
    case 'bet.scan':
      return postJson(serviceBase('betting'), '/internal/betting/scan', body);
    case 'bet.stop_loss':
      return postJson(serviceBase('stopLoss'), '/internal/stop-loss/scan', body);
    default: {
      const err = new Error(`unsupported jobType: ${job.jobType}`);
      err.status = 400;
      throw err;
    }
  }
}

module.exports = { executeJobTypeHttp, serviceBase };
