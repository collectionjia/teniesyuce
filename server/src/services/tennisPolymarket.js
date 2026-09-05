/**
 * 刷新网球 bundle 中 Polymarket moneyline 隐含价（与外链页对齐）。
 * 日包只采一次价，完赛后外链已结算成 100/0 而详情仍显示中途价。
 */
const GAMMA = 'https://gamma-api.polymarket.com';
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

async function fetchEventBySlug(slug) {
  const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'yuce-bid/1.0',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`gamma HTTP ${res.status}`);
  const body = await res.json();
  if (Array.isArray(body)) return body[0] || null;
  return body;
}

function applyLivePrices(poly, ev) {
  if (!poly || !ev) return poly;
  const mkt = pickMoneylineMarket(ev.markets);
  const prices = parsePrices(mkt);
  if (!prices) return poly;
  const outcomes = parseJsonField(mkt.outcomes, poly.moneyline?.outcomes || []);
  const next = {
    ...poly,
    active: ev.active != null ? !!ev.active : poly.active,
    closed: ev.closed != null ? !!ev.closed : poly.closed,
    home_price: prices[0],
    away_price: prices[1],
    moneyline: {
      ...(poly.moneyline || {}),
      question: mkt.question || poly.moneyline?.question,
      slug: mkt.slug || poly.moneyline?.slug || poly.slug,
      outcomes: outcomes.length >= 2 ? outcomes : poly.moneyline?.outcomes,
      prices,
    },
    pricesUpdatedAt: new Date().toISOString(),
  };
  return next;
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
  if (!map || typeof map !== 'object') return { updated: 0, failed: 0 };
  const entries = Object.entries(map).filter(([, v]) => v && (v.slug || v.url));
  if (!entries.length) return { updated: 0, failed: 0 };

  let updated = 0;
  let failed = 0;
  await mapPool(entries, CONCURRENCY, async ([id, poly]) => {
    const slug = extractSlug(poly);
    if (!slug) return;
    try {
      const ev = await fetchEventBySlug(slug);
      if (!ev) {
        failed += 1;
        return;
      }
      const next = applyLivePrices(poly, ev);
      if (next !== poly && next.moneyline?.prices) {
        map[id] = next;
        updated += 1;
      }
    } catch (e) {
      failed += 1;
      console.warn(`[tennis/poly-refresh] ${slug}:`, e.message || e);
    }
  });

  return { updated, failed };
}

module.exports = {
  refreshPolymarketPrices,
  extractSlug,
  applyLivePrices,
  parsePrices,
};
