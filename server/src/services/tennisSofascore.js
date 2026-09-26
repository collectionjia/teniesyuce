/**
 * 盘中比分：IPWO → Sofascore API（与 tennisPolymarket.js 对称，赔率走 PM 直连）。
 */
const { httpsGetJson } = require('../lib/httpProxyAgent');

const API_BASE = (process.env.SOFA_API_BASE || 'https://www.sofascore.com/api/v1').replace(/\/$/, '');
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.SOFA_MIN_INTERVAL || 0.5) * 1000);
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.SOFA_REQUEST_TIMEOUT_SEC || 90) * 1000);
const REQUEST_RETRIES = Math.max(1, Number(process.env.SOFA_REQUEST_RETRIES || 3));
const RETRY_BACKOFF_MS = Math.max(500, Number(process.env.SOFA_REQUEST_RETRY_BACKOFF_SEC || 3) * 1000);
const SOFA_SCOPE = 'Sofascore';

const SOFA_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.sofascore.com/tennis',
  Origin: 'https://www.sofascore.com',
  'Cache-Control': 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

let lastRequestAt = 0;

function matchLabel(m) {
  const home = m?.home || m?.homePlayer?.name || '?';
  const away = m?.away || m?.awayPlayer?.name || '?';
  return `${home} vs ${away}`;
}

function eventScore(ev) {
  const hs = ev?.homeScore || {};
  const as_ = ev?.awayScore || {};
  if (typeof hs !== 'object' || typeof as_ !== 'object') return null;
  const parts = [];
  for (const key of ['period1', 'period2', 'period3', 'period4', 'period5']) {
    if (hs[key] != null && as_[key] != null) parts.push(`${hs[key]}-${as_[key]}`);
  }
  if (parts.length) return parts.join(' ');
  if (hs.current != null && as_.current != null) return `${hs.current}-${as_.current}`;
  return null;
}

function slimEvent(ev) {
  const status = typeof ev?.status === 'object' ? ev.status : {};
  const hs = ev?.homeScore;
  const as_ = ev?.awayScore;
  const eid = ev?.id;
  const slug = ev?.slug;
  return {
    id: eid,
    status: status.description || ev?.status,
    statusType: status.type || ev?.statusType,
    homeScore: hs,
    awayScore: as_,
    home_score: typeof hs === 'object' ? hs?.current : hs,
    away_score: typeof as_ === 'object' ? as_?.current : as_,
    scoreText: eventScore(ev),
    slug,
    customId: ev?.customId,
    url: slug
      ? `https://www.sofascore.com/event/tennis/${slug}`
      : eid != null
        ? `https://www.sofascore.com/event/tennis/${eid}`
        : null,
  };
}

function applySofaSlimToMatch(match, slim) {
  if (!match || !slim) return match;
  for (const key of [
    'status',
    'statusType',
    'homeScore',
    'awayScore',
    'home_score',
    'away_score',
    'scoreText',
    'slug',
    'customId',
    'url',
  ]) {
    if (slim[key] != null) match[key] = slim[key];
  }
  const st = String(match.statusType || '').toLowerCase().trim();
  if (st === 'finished' || st === 'ended') {
    match.phaseMark = 'ended';
    match.phaseLabel = '已结束';
  } else if (st === 'inprogress' || st === 'paused' || st === 'interrupted') {
    match.phaseMark = 'live';
    match.phaseLabel = '进行中';
  } else if (st === 'notstarted') {
    match.phaseMark = 'not_started';
    match.phaseLabel = '未开赛';
  }
  return match;
}

function isRetryable(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return ['timeout', '403', '429', 'connection', 'econnreset', 'socket'].some((x) => msg.includes(x));
}

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function sofaApiGet(path) {
  const url = `${API_BASE}/${String(path).replace(/^\//, '')}`;
  let lastErr = null;
  for (let attempt = 0; attempt < REQUEST_RETRIES; attempt += 1) {
    try {
      await throttle();
      lastRequestAt = Date.now();
      return await httpsGetJson(url, {
        scope: SOFA_SCOPE,
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: SOFA_HEADERS,
      });
    } catch (err) {
      lastErr = err;
      if (attempt + 1 >= REQUEST_RETRIES || !isRetryable(err)) break;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  throw lastErr || new Error(`Sofascore request failed: ${url}`);
}

async function fetchLiveTennisEvents() {
  const body = await sofaApiGet('sport/tennis/events/live');
  const events = Array.isArray(body?.events) ? body.events : [];
  const byId = new Map();
  for (const ev of events) {
    if (ev?.id == null) continue;
    byId.set(Number(ev.id), ev);
  }
  return { events, byId };
}

async function fetchEvent(eventId) {
  const body = await sofaApiGet(`event/${eventId}`);
  const inner = body?.event;
  if (!inner || typeof inner !== 'object') throw new Error('empty event payload');
  return inner;
}

/** 每次刷新前从引擎库加载 IPWO，避免后台循环丢代理配置 */
async function ensureInplayProxyEnv() {
  const tennisEngines = require('./tennisEngines');
  const cfg = await tennisEngines.getConfig();
  Object.assign(process.env, tennisEngines.buildProxyProcessEnv(cfg, 'inplay'));
  process.env.COLLECT_PROXY_JOB = 'inplay';
  // Sofascore 统一走 IPWO；不被盘中 PM 直连 tick 的 COLLECT_INPLAY_USE_PROXY=0 污染
  process.env.COLLECT_INPLAY_USE_PROXY = '1';
}

/**
 * 刷新盘中包内所有场次的 Sofascore 比分（不要求 PM slug），写回 Redis。
 * @param {{ matches?: object[] }} [opts]
 */
async function refreshInplayScoresOnce(opts = {}) {
  if (require('./tennisBackgroundPause').isTennisBackgroundRefreshPaused()) {
    return {
      ok: true,
      skipped: true,
      updated: 0,
      failed: 0,
      tracked: 0,
      reason: 'full-collect pause',
    };
  }
  await ensureInplayProxyEnv();
  const tennisThreeBuckets = require('./tennisThreeBuckets');
  const buckets = await tennisThreeBuckets.loadAllTennisBuckets();
  const bundle = buckets.inplay;

  let byId;
  let fetchIds;
  if (Array.isArray(opts.matches)) {
    byId = new Map();
    for (const m of opts.matches) {
      if (m?.id == null) continue;
      byId.set(String(m.id), { refs: [m], sample: m });
    }
    fetchIds = byId;
  } else {
    byId = tennisThreeBuckets.indexMatchRefsById(buckets);
    const inplayIds = tennisThreeBuckets.indexMatchRefsById({ inplay: buckets.inplay });
    fetchIds = inplayIds.size ? inplayIds : byId;
  }
  if (!fetchIds.size) {
    return {
      ok: true,
      updated: 0,
      failed: 0,
      tracked: 0,
      skipped: true,
      reason: 'no inplay match ids',
      source: 'sofascore-ipwo',
      upstream: 'ipwo-sofascore',
      process_log: '[sofa] no match ids',
    };
  }

  const lines = [`[sofa] tracked=${fetchIds.size}`];
  let updated = 0;
  let failed = 0;
  let liveFeed = 0;
  let detailFetch = 0;
  const missed = [];
  const scorePatches = new Map();

  let liveById = new Map();
  try {
    const live = await fetchLiveTennisEvents();
    liveById = live.byId;
    lines.push(`[sofa] live feed=${liveById.size}`);
  } catch (err) {
    const reason = err.message || String(err);
    lines.push(`[sofa] live list failed: ${reason}`);
    console.warn('[tennis/sofa] live list failed:', reason);
  }

  for (const [idKey, inplayRow] of fetchIds) {
    const allRow = byId.get(idKey) || inplayRow;
    const { refs, sample: match } = allRow;
    const iid = Number(idKey);
    const label = matchLabel(match);
    try {
      let raw = liveById.get(iid);
      if (raw) {
        liveFeed += 1;
      } else {
        raw = await fetchEvent(iid);
        detailFetch += 1;
      }
      const slim = slimEvent(raw);
      for (const ref of refs) applySofaSlimToMatch(ref, slim);
      const patch = tennisThreeBuckets.pickScorePatch(match);
      if (patch) scorePatches.set(idKey, patch);
      updated += 1;
      lines.push(`[sofa] ok id=${idKey} ${label} score=${match.scoreText || '-'}`);
    } catch (err) {
      failed += 1;
      const reason = err.message || String(err);
      missed.push({ id: idKey, home: match.home, away: match.away, reason });
      lines.push(`[sofa] fail id=${idKey} ${label}: ${reason}`);
      console.warn(`[tennis/sofa] id=${idKey}:`, reason);
    }
  }

  const now = new Date().toISOString();
  const sync =
    scorePatches.size > 0
      ? await tennisThreeBuckets.writeScorePatches(scorePatches, {
          score_updated_at: now,
          tick_at: now,
        })
      : null;
  const written = sync ? Object.values(sync).some((r) => r.written) : false;
  const ok = written && (updated > 0 || failed === 0);
  lines.push(`[sofa] done updated=${updated} failed=${failed} live=${liveFeed} detail=${detailFetch}`);
  if (sync) lines.push(`[sofa] synced buckets=${JSON.stringify(sync)}`);

  return {
    ok,
    written,
    updated,
    failed,
    tracked: fetchIds.size,
    liveFeed,
    detailFetch,
    synced: sync,
    missed: missed.slice(0, 50),
    source: 'sofascore-ipwo',
    upstream: 'ipwo-sofascore',
    score_updated_at: updated > 0 ? now : bundle?.score_updated_at || null,
    error: !written && updated > 0 ? 'redis write failed' : failed > 0 && updated === 0 ? 'all score fetches failed' : null,
    process_log: lines.join('\n'),
  };
}

/**
 * 刷新盘中单场 Sofascore 比分并写回 Redis。
 * @param {string|number} eventId
 */
async function refreshInplayScoresByEventId(eventId) {
  const idKey = String(eventId ?? '').trim();
  if (!idKey) return { ok: false, error: 'empty eventId' };

  const tennisThreeBuckets = require('./tennisThreeBuckets');
  const buckets = await tennisThreeBuckets.loadAllTennisBuckets();
  const byId = tennisThreeBuckets.indexMatchRefsById(buckets);
  const row = byId.get(idKey);
  if (!row?.refs?.length) return { ok: false, error: 'match not in any bundle', eventId: idKey };

  await ensureInplayProxyEnv();
  try {
    let raw = null;
    try {
      const live = await fetchLiveTennisEvents();
      raw = live.byId.get(Number(idKey)) || null;
    } catch {
      /* live list optional */
    }
    if (!raw) raw = await fetchEvent(idKey);
    const slim = slimEvent(raw);
    for (const ref of row.refs) applySofaSlimToMatch(ref, slim);
    const match = row.sample;
    const patch = tennisThreeBuckets.pickScorePatch(match);
    if (!patch) return { ok: false, eventId: idKey, error: 'empty score patch' };
    const now = new Date().toISOString();
    const sync = await tennisThreeBuckets.writeScorePatches(new Map([[idKey, patch]]), {
      score_updated_at: now,
      tick_at: now,
    });
    const written = Object.values(sync).some((r) => r.written);
    return {
      ok: written,
      written,
      eventId: idKey,
      scoreText: match.scoreText,
      status: match.status,
      statusType: match.statusType,
      synced: sync,
      score_updated_at: now,
    };
  } catch (err) {
    return { ok: false, eventId: idKey, error: err.message || String(err) };
  }
}

module.exports = {
  sofaApiGet,
  eventScore,
  slimEvent,
  applySofaSlimToMatch,
  fetchLiveTennisEvents,
  fetchEvent,
  refreshInplayScoresOnce,
  refreshInplayScoresByEventId,
};

function loadEnv() {
  try {
    const path = require('path');
    require('dotenv').config({
      path: process.env.ENV_FILE
        ? path.resolve(process.cwd(), process.env.ENV_FILE)
        : path.join(__dirname, '..', '..', '.env'),
      override: false,
    });
  } catch {
    /* optional */
  }
}

async function main(argv = process.argv.slice(2)) {
  loadEnv();
  const args = argv.filter((a) => a && !a.startsWith('-'));
  const flags = new Set(argv.filter((a) => a.startsWith('-') && !a.includes('=')));
  const kv = Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--') && a.includes('='))
      .map((a) => {
        const i = a.indexOf('=');
        return [a.slice(2, i), a.slice(i + 1)];
      }),
  );
  const eventId = args[0] || process.env.SOFA_TEST_EVENT_ID || '';
  const wantLoop = flags.has('--loop');
  const wantBundle = flags.has('--bundle');

  if ((!eventId && !wantLoop && !wantBundle) || flags.has('-h') || flags.has('--help')) {
    console.log(`用法:
  node src/services/tennisSofascore.js <event-id> [--json]
  node src/services/tennisSofascore.js --bundle [--interval=30000]
  node src/services/tennisSofascore.js --loop [--interval=30000]

选项:
  --bundle            刷新 Redis 盘中包内全部场次比分
  --loop              同 --bundle 循环执行
  --interval=30000    循环间隔毫秒（默认 30000）
  --json              输出完整 JSON
`);
    process.exitCode = eventId || wantLoop || wantBundle ? 0 : 1;
    return;
  }

  await ensureInplayProxyEnv();

  const runBundle = async () => {
    const r = await refreshInplayScoresOnce();
    if (flags.has('--json')) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(r.process_log || `[sofa] updated=${r.updated} failed=${r.failed}`);
    }
    if (!r.ok) process.exitCode = 1;
    return r;
  };

  if (wantLoop || wantBundle) {
    const intervalMs = Math.max(5000, Number(kv.interval || process.env.SOFA_SCORE_LOOP_MS || 30000));
    if (wantLoop) {
      console.log(`[sofa-loop] start interval=${intervalMs}ms`);
      for (;;) {
        const t0 = Date.now();
        await runBundle();
        const wait = Math.max(0, intervalMs - (Date.now() - t0));
        await new Promise((r) => setTimeout(r, wait));
      }
      return;
    }
    await runBundle();
    return;
  }

  let result;
  try {
    const raw = await fetchEvent(eventId);
    const slim = slimEvent(raw);
    if (flags.has('--json')) {
      console.log(JSON.stringify(slim, null, 2));
      return;
    }
    console.log(`id=${slim.id} status=${slim.statusType || '-'} score=${slim.scoreText || '-'}`);
    result = slim;
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
    if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
