/**
 * 刷新网球 bundle 中 Polymarket moneyline 价。
 * 优先 CLOB order book mid（贴盘口深度），无盘口时回退 Gamma outcomePrices。
 */
const { httpsGetJson } = require('../lib/httpProxyAgent');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = process.env.POLY_CLOB_BASE || 'https://clob.polymarket.com';
const CONCURRENCY = 4;

function extractSlug(poly) {
  if (!poly || typeof poly !== 'object') return '';
  if (poly.slug) return String(poly.slug).trim();
  const url = String(poly.url || '');
  const m = url.match(/polymarket\.com\/event\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : '';
}

function parseJsonField(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}

function pickMoneylineMarket(markets) {
  const list = markets || [];
  for (const candidate of list) {
    const outs = parseJsonField(candidate.outcomes, []).map(String);
    if (outs.length >= 2 && !/^(yes|no)$/i.test(outs[0])) return candidate;
  }
  return list[0] || null;
}

function parsePrices(mkt) {
  let prices = parseJsonField(mkt?.outcomePrices, null);
  if (!Array.isArray(prices) || prices.length < 2) {
    prices = parseJsonField(mkt?.prices, null);
  }
  if (!Array.isArray(prices) || prices.length < 2) return null;
  const a = Number(prices[0]);
  const b = Number(prices[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function parseTokenIds(mkt) {
  const tokens = parseJsonField(mkt?.clobTokenIds, []);
  if (!Array.isArray(tokens)) return [];
  return tokens.filter(Boolean).map(String);
}

async function bookMidPrice(tokenId) {
  if (!tokenId) return null;
  try {
    const book = await httpsGetJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, {
      scope: 'Polymarket',
      timeoutMs: Number(process.env.POLY_REQUEST_TIMEOUT_MS) || 15000,
    });
    const bids = book?.bids || [];
    const asks = book?.asks || [];
    const bestBid = bids.length ? Math.max(...bids.map((b) => Number(b.price) || 0)) : 0;
    const bestAsk = asks.length ? Math.min(...asks.map((a) => Number(a.price) || 0)) : 0;
    if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
    if (bestBid > 0) return bestBid;
    if (bestAsk > 0) return bestAsk;
    return null;
  } catch (e) {
    console.warn(`[tennis/poly-clob] book ${String(tokenId).slice(0, 12)}…:`, e.message || e);
    return null;
  }
}

async function parsePricesFromClob(mkt) {
  const tokens = parseTokenIds(mkt);
  if (tokens.length < 2) return null;
  const [a, b] = await Promise.all([bookMidPrice(tokens[0]), bookMidPrice(tokens[1])]);
  if (a == null || b == null) return null;
  return [a, b];
}

async function fetchEventBySlug(slug) {
  const body = await httpsGetJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, {
    scope: 'Polymarket',
    timeoutMs: Number(process.env.POLY_REQUEST_TIMEOUT_MS) || 15000,
  });
  if (Array.isArray(body)) return body[0] || null;
  return body;
}

async function applyLivePrices(poly, ev, { clobOnly = false } = {}) {
  if (!poly || !ev) return poly;
  const mkt = pickMoneylineMarket(ev.markets);
  let source = 'clob';
  let prices = await parsePricesFromClob(mkt);
  if (!prices) {
    if (clobOnly) return poly;
    source = 'gamma';
    prices = parsePrices(mkt);
  }
  if (!prices) return poly;
  const outcomes = parseJsonField(mkt?.outcomes, poly.moneyline?.outcomes || []);
  return {
    ...poly,
    active: ev.active != null ? !!ev.active : poly.active,
    closed: ev.closed != null ? !!ev.closed : poly.closed,
    home_price: prices[0],
    away_price: prices[1],
    priceSource: source,
    moneyline: {
      ...(poly.moneyline || {}),
      question: mkt?.question || poly.moneyline?.question,
      slug: mkt?.slug || poly.moneyline?.slug || poly.slug,
      outcomes: outcomes.length >= 2 ? outcomes : poly.moneyline?.outcomes,
      prices,
      source,
    },
    pricesUpdatedAt: new Date().toISOString(),
  };
}

/**
 * 按 Polymarket event slug 更新 moneyline 赔率（CLOB mid，可选回退 Gamma）。
 * @param {string} slug
 * @param {{ clobOnly?: boolean, poly?: object }} [opts]
 * @returns {Promise<{ ok: boolean, slug: string, poly?: object, error?: string }>}
 */
async function updatePolymarketOddsBySlug(slug, opts = {}) {
  const raw = String(slug || '').trim();
  if (!raw) return { ok: false, slug: '', error: 'empty slug' };
  const clobOnly = opts.clobOnly === true;
  const base =
    opts.poly && typeof opts.poly === 'object'
      ? { ...opts.poly, slug: opts.poly.slug || raw }
      : { slug: raw };
  try {
    const ev = await fetchEventBySlug(raw);
    if (!ev) return { ok: false, slug: raw, error: 'empty event' };
    const next = await applyLivePrices(base, ev, { clobOnly });
    const prices = next?.moneyline?.prices;
    if (!Array.isArray(prices) || prices.length < 2) {
      return {
        ok: false,
        slug: raw,
        poly: next,
        error: clobOnly ? 'no clob book price' : 'no moneyline prices',
      };
    }
    return {
      ok: true,
      slug: raw,
      poly: next,
      source: next.priceSource || next.moneyline?.source,
      home_price: next.home_price,
      away_price: next.away_price,
      title: ev.title || null,
    };
  } catch (e) {
    return { ok: false, slug: raw, error: e.message || String(e) };
  }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/**
 * 就地刷新 bundle.polymarketByEvent 的 moneyline 价。
 * @returns {{ updated: number, failed: number }}
 */
async function refreshPolymarketPrices(bundle) {
  const map = bundle?.polymarketByEvent;
  if (!map || typeof map !== 'object') {
    return { updated: 0, failed: 0, process_log: '[poly] no polymarketByEvent' };
  }
  const entries = Object.entries(map).filter(([, v]) => v && (v.slug || v.url));
  if (!entries.length) {
    return { updated: 0, failed: 0, process_log: '[poly] no slugs' };
  }

  let updated = 0;
  let failed = 0;
  const failures = [];
  const lines = [`[poly] candidates=${entries.length}`];
  await mapPool(entries, CONCURRENCY, async ([id, poly]) => {
    const slug = extractSlug(poly);
    if (!slug) {
      failed += 1;
      failures.push({ id, reason: 'no slug' });
      lines.push(`[poly] fail id=${id}: no slug`);
      return;
    }
    try {
      const ev = await fetchEventBySlug(slug);
      if (!ev) {
        failed += 1;
        failures.push({ id, slug, reason: 'empty event' });
        lines.push(`[poly] fail id=${id} slug=${slug}: empty`);
        return;
      }
      const next = await applyLivePrices(poly, ev, { clobOnly: false });
      if (next !== poly && next.moneyline?.prices) {
        map[id] = next;
        updated += 1;
        lines.push(`[poly] ok id=${id} slug=${slug} source=${next.priceSource || next.moneyline?.source || '?'}`);
      } else {
        failed += 1;
        failures.push({ id, slug, reason: 'no moneyline prices' });
        lines.push(`[poly] fail id=${id} slug=${slug}: no moneyline prices`);
      }
    } catch (e) {
      failed += 1;
      const reason = e.message || String(e);
      failures.push({ id, slug, reason });
      lines.push(`[poly] fail id=${id} slug=${slug}: ${reason}`);
      console.warn(`[tennis/poly-refresh] ${slug}:`, reason);
    }
  });

  lines.push(`[poly] done updated=${updated} failed=${failed}`);
  return {
    updated,
    failed,
    failures,
    process_log: lines.join('\n'),
  };
}

/**
 * 刷新盘中包内每个有 slug 的赛事赔率，写回 Redis。
 * @param {{ clobOnly?: boolean, concurrency?: number }} [opts]
 */
async function refreshInplayOddsOnce(opts = {}) {
  const clobOnly = opts.clobOnly !== false; // 默认 CLOB-only，避免结算价 0/1
  const concurrency = Math.max(1, Number(opts.concurrency) || CONCURRENCY);
  const inplayCache = require('./tennisInplayCache');
  const bundle = await inplayCache.getBundle();
  if (!bundle) {
    return { ok: false, updated: 0, failed: 0, scanned: 0, error: 'empty inplay bundle' };
  }
  const map = bundle.polymarketByEvent;
  if (!map || typeof map !== 'object') {
    return { ok: false, updated: 0, failed: 0, scanned: 0, error: 'no polymarketByEvent' };
  }

  const entries = Object.entries(map).filter(([, v]) => v && extractSlug(v));
  let updated = 0;
  let failed = 0;
  const rows = [];

  await mapPool(entries, concurrency, async ([id, poly]) => {
    const slug = extractSlug(poly);
    const r = await updatePolymarketOddsBySlug(slug, { clobOnly, poly });
    if (r.ok && r.poly) {
      map[id] = r.poly;
      updated += 1;
      rows.push({
        id,
        slug,
        ok: true,
        home_price: r.home_price,
        away_price: r.away_price,
        source: r.source,
        outcomes: r.poly?.moneyline?.outcomes,
        prices: r.poly?.moneyline?.prices,
      });
    } else {
      failed += 1;
      rows.push({ id, slug, ok: false, error: r.error || 'fail' });
    }
  });

  const now = new Date().toISOString();
  bundle.odds_updated_at = now;
  bundle.tick_at = bundle.tick_at || now;
  const written = await inplayCache.setCachedBundle(bundle, now);
  return {
    ok: written && failed === 0,
    written,
    updated,
    failed,
    scanned: entries.length,
    rows,
    odds_updated_at: now,
  };
}

/**
 * 刷新盘中单场 Polymarket 赔率并写回 Redis（详情页异步用）。
 * @param {string|number} eventId
 * @param {{ clobOnly?: boolean }} [opts]
 */
async function refreshInplayOddsByEventId(eventId, opts = {}) {
  const clobOnly = opts.clobOnly !== false;
  const idKey = String(eventId ?? '').trim();
  if (!idKey) return { ok: false, error: 'empty eventId' };

  const inplayCache = require('./tennisInplayCache');
  const bundle = await inplayCache.getBundle();
  if (!bundle) return { ok: false, error: 'empty inplay bundle', eventId: idKey };

  const map = bundle.polymarketByEvent;
  if (!map || typeof map !== 'object') {
    return { ok: false, error: 'no polymarketByEvent', eventId: idKey };
  }

  const poly = map[idKey] || map[Number(idKey)] || null;
  if (!poly || typeof poly !== 'object') {
    return { ok: false, error: 'no poly for event', eventId: idKey };
  }
  const slug = extractSlug(poly);
  if (!slug) return { ok: false, error: 'no slug', eventId: idKey };

  const r = await updatePolymarketOddsBySlug(slug, { clobOnly, poly });
  if (!r.ok || !r.poly) {
    return { ok: false, eventId: idKey, slug, error: r.error || 'refresh failed' };
  }

  map[idKey] = r.poly;
  if (map[Number(idKey)] != null && String(Number(idKey)) !== idKey) {
    map[Number(idKey)] = r.poly;
  }

  const now = new Date().toISOString();
  bundle.odds_updated_at = now;
  const written = await inplayCache.setCachedBundle(bundle, now);
  return {
    ok: !!written,
    written,
    eventId: idKey,
    slug,
    poly: r.poly,
    home_price: r.home_price,
    away_price: r.away_price,
    source: r.source,
    odds_updated_at: now,
  };
}

async function runInplayOddsLoop(opts = {}) {
  const intervalMs = Math.max(200, Number(opts.intervalMs) || 1000);
  const clobOnly = opts.clobOnly !== false;
  const quiet = opts.quiet === true;
  process.env.COLLECT_INPLAY_USE_PROXY = process.env.COLLECT_INPLAY_USE_PROXY || '0';
  console.log(`[odds-loop] start interval=${intervalMs}ms clobOnly=${clobOnly}`);
  for (;;) {
    const t0 = Date.now();
    const warn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await refreshInplayOddsOnce({ clobOnly });
    } catch (e) {
      result = { ok: false, error: e.message || String(e), updated: 0, failed: 0, scanned: 0 };
    } finally {
      console.warn = warn;
    }
    const ms = Date.now() - t0;
    if (!quiet) {
      for (const row of result.rows || []) {
        if (!row.ok) {
          console.log(`[odds] id=${row.id} ${row.slug} FAIL ${row.error}`);
          continue;
        }
        const outs = row.outcomes || ['home', 'away'];
        const prices = row.prices || [row.home_price, row.away_price];
        console.log(
          `[odds] id=${row.id} ${outs[0] || '?'} ${prices[0]} | ${outs[1] || '?'} ${prices[1]} (${row.source})`,
        );
      }
    }
    console.log(
      `[odds-loop] scanned=${result.scanned || 0} updated=${result.updated || 0} failed=${result.failed || 0} ${ms}ms`,
    );
    const wait = Math.max(0, intervalMs - ms);
    await new Promise((r) => setTimeout(r, wait));
  }
}

module.exports = {
  refreshPolymarketPrices,
  refreshInplayOddsOnce,
  refreshInplayOddsByEventId,
  runInplayOddsLoop,
  updatePolymarketOddsBySlug,
  extractSlug,
  applyLivePrices,
  fetchEventBySlug,
  parsePrices,
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
  const slug = args[0] || process.env.POLY_TEST_SLUG || '';
  const wantLoop = flags.has('--loop');

  if ((!slug && !wantLoop) || flags.has('-h') || flags.has('--help')) {
    console.log(`用法:
  node src/services/tennisPolymarket.js <event-slug> [--clob-only] [--json]
  node src/services/tennisPolymarket.js --loop [--interval=1000] [--clob-only] [--quiet]

选项:
  --loop              盘中包每场有 slug 的赛事循环刷新赔率并写 Redis
  --interval=1000     循环间隔毫秒（默认 1000）
  --clob-only         仅用 CLOB mid（--loop 默认即如此；单场需显式加）
  --quiet             循环时只打汇总行
  --json              单场输出完整 JSON
`);
    process.exitCode = slug || wantLoop ? 0 : 1;
    return;
  }

  process.env.COLLECT_INPLAY_USE_PROXY = process.env.COLLECT_INPLAY_USE_PROXY || '0';

  if (wantLoop) {
    const intervalMs = Number(kv.interval || process.env.POLY_ODDS_LOOP_MS || 1000);
    await runInplayOddsLoop({
      intervalMs,
      clobOnly: !flags.has('--gamma'), // --loop 默认 clob；--gamma 允许回退
      quiet: flags.has('--quiet'),
    });
    return;
  }

  const clobOnly = flags.has('--clob-only');
  const wantJson = flags.has('--json');

  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await updatePolymarketOddsBySlug(slug, { clobOnly });
  } finally {
    console.warn = warn;
  }

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  const ml = result.poly?.moneyline || {};
  const outs = (ml.outcomes || []).map(String);
  const prices = Array.isArray(ml.prices) ? ml.prices : [];
  let printed = 0;
  if (outs.length >= 2 && prices.length >= 2) {
    for (let i = 0; i < 2; i++) {
      const p = Number(prices[i]);
      if (!Number.isFinite(p)) continue;
      console.log(`${outs[i]} ${p}`);
      printed += 1;
    }
  } else {
    const home = Number(result.home_price);
    const away = Number(result.away_price);
    if (Number.isFinite(home)) {
      console.log(`home ${home}`);
      printed += 1;
    }
    if (Number.isFinite(away)) {
      console.log(`away ${away}`);
      printed += 1;
    }
  }
  if (!printed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
