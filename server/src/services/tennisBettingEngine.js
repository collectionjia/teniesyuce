/**
 * 投注引擎：盘前 / 盘中分桶；多组 OR；组内买入条件 AND；止损按组配置
 * tick 后先止损再买入。
 */
const redis = require('./redis');
const tennisEngines = require('./tennisEngines');
const tennisInplayCache = require('./tennisInplayCache');
const tennisPrematchCache = require('./tennisPrematchCache');
const tennisTrade = require('./tennisTrade');
const tennisConditionApply = require('./tennisConditionApply');

const STATE_KEY = 'tennis:engines:betting:state';

async function loadState() {
  const client = await redis.getClient();
  if (!client) return { placed: {}, sold: {} };
  try {
    const raw = await client.get(STATE_KEY);
    if (!raw) return { placed: {}, sold: {} };
    const j = JSON.parse(raw);
    return { placed: j.placed || {}, sold: j.sold || {} };
  } catch {
    return { placed: {}, sold: {} };
  }
}

async function saveState(state) {
  const client = await redis.getClient();
  if (!client) return;
  await client.set(STATE_KEY, JSON.stringify(state));
}

function ensureUidState(state, uid) {
  if (!state.placed[uid] || Array.isArray(state.placed[uid])) {
    const old = Array.isArray(state.placed[uid]) ? state.placed[uid].map(String) : [];
    state.placed[uid] = {
      'tennis-prematch': [],
      'tennis-inplay': old,
    };
  }
  if (!state.sold[uid] || Array.isArray(state.sold[uid])) {
    const old = Array.isArray(state.sold[uid]) ? state.sold[uid].map(String) : [];
    state.sold[uid] = {
      'tennis-prematch': [],
      'tennis-inplay': old,
    };
  }
  if (!state.placed[uid]['tennis-prematch']) state.placed[uid]['tennis-prematch'] = [];
  if (!state.placed[uid]['tennis-inplay']) state.placed[uid]['tennis-inplay'] = [];
  if (!state.sold[uid]['tennis-prematch']) state.sold[uid]['tennis-prematch'] = [];
  if (!state.sold[uid]['tennis-inplay']) state.sold[uid]['tennis-inplay'] = [];
}

function polyPrices(poly) {
  return poly?.moneyline?.prices || poly?.prices || {};
}

function currentRank(player, rankings) {
  const id = player?.id ?? player?.teamId;
  const fromMap = id != null ? rankings[String(id)] || rankings[id] : null;
  const n = Number(fromMap?.current ?? player?.ranking ?? player?.currentRank);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function pickStrongSide(m, rankings) {
  const homeR = currentRank(m.homePlayer || { name: m.home }, rankings);
  const awayR = currentRank(m.awayPlayer || { name: m.away }, rankings);
  if (homeR == null || awayR == null) return null;
  return homeR < awayR ? 'home' : 'away';
}

function isLimited(v) {
  return v != null && v !== '' && v !== 'all';
}

function strongPolyCents(m, bundle, side) {
  const poly = bundle.polymarketByEvent?.[String(m.id)] || bundle.polymarketByEvent?.[m.id];
  if (!poly?.url && !poly?.slug) return null;
  const prices = polyPrices(poly);
  const v = prices[side] ?? prices[side === 'home' ? 'home' : 'away'];
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

function scoreSide(m, which) {
  const block = which === 'home'
    ? (m.homeScore || m.score?.home || {})
    : (m.awayScore || m.score?.away || {});
  return block;
}

function periodScore(block, i) {
  const key = `period${i}`;
  const setKey = `set${i}`;
  const n = Number(block[key] ?? block[setKey] ?? (Array.isArray(block.periods) ? block.periods[i - 1] : null));
  return Number.isFinite(n) ? n : null;
}

function isSetComplete(a, b) {
  if (a == null || b == null) return false;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi >= 6 && hi - lo >= 2) return true;
  if (hi >= 7 && lo >= 5) return true;
  return false;
}

function strongWonFirstSet(m, side) {
  const hs = scoreSide(m, 'home');
  const as = scoreSide(m, 'away');
  const h1 = periodScore(hs, 1);
  const a1 = periodScore(as, 1);
  if (h1 == null || a1 == null || h1 === a1) return false;
  if (!isSetComplete(h1, a1)) return false;
  const homeWon = h1 > a1;
  return side === 'home' ? homeWon : !homeWon;
}

/** 解析「7:5」「7-5」→ { hi, lo }；无效返回 null */
function parseGameScorePair(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*[:\-–／/]\s*(\d+)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { hi: Math.max(a, b), lo: Math.min(a, b) };
}

/** 首盘局分是否命中排除形（如 7:5，顺序无关） */
function firstSetMatchesExcludeScore(m, excludeRaw) {
  const pair = parseGameScorePair(excludeRaw);
  if (!pair) return false;
  const hs = scoreSide(m, 'home');
  const as = scoreSide(m, 'away');
  const h1 = periodScore(hs, 1);
  const a1 = periodScore(as, 1);
  if (h1 == null || a1 == null) return false;
  const hi = Math.max(h1, a1);
  const lo = Math.min(h1, a1);
  return hi === pair.hi && lo === pair.lo;
}

function analyzeSets(m, strongSide) {
  const hs = scoreSide(m, 'home');
  const as = scoreSide(m, 'away');
  let strongSets = 0;
  let weakSets = 0;
  let current = null;
  for (let i = 1; i <= 5; i++) {
    const h = periodScore(hs, i);
    const a = periodScore(as, i);
    if (h == null || a == null) break;
    const s = strongSide === 'home' ? h : a;
    const w = strongSide === 'home' ? a : h;
    if (isSetComplete(s, w)) {
      if (s > w) strongSets += 1;
      else weakSets += 1;
    } else {
      current = { strong: s, weak: w, setIndex: i };
      break;
    }
  }
  return { strongSets, weakSets, current };
}

function isBo5(m) {
  const { strongSets, weakSets, current } = analyzeSets(m, 'home');
  if ((strongSets + weakSets + (current ? 1 : 0)) >= 4) return true;
  const label = String(m?.level || m?.tournament || '').toLowerCase();
  const gender = String(m.gender || m.homePlayer?.gender || '').toUpperCase();
  if (gender === 'F' || gender === 'W') return false;
  return /\bgs\b|grand.?slam/.test(label);
}

function gamesTrailStop(strongG, weakG, lead) {
  const need = Number(lead);
  const n = Number.isFinite(need) ? need : 2;
  return strongG < weakG && weakG - strongG > n;
}

/** 买入：产品 betting_select 解析出的条件组链（组内 AND，组间 joinPrev） */
function passesEntry(m, rankings, entryGroups, bundle) {
  const list = Array.isArray(entryGroups) ? entryGroups : [];
  if (!list.length) return false;
  return tennisConditionApply.evalGroupsChain(list, (g) => tennisConditionApply.passGroup(m, g, bundle));
}

function matchStopRule(m, side, rule) {
  const { strongSets, weakSets, current } = analyzeSets(m, side);
  if (!current) return false;

  const fmt = String(rule.stopFormat || 'any').toLowerCase();
  const bo5 = isBo5(m);
  if (fmt === 'bo3' && bo5) return false;
  if (fmt === 'bo5' && !bo5) return false;

  const setIndex = Number(rule.stopSetIndex);
  if (Number.isFinite(setIndex) && setIndex > 0 && current.setIndex !== setIndex) return false;

  if (rule.stopStrongSets != null && rule.stopStrongSets !== '' && rule.stopStrongSets !== 'all') {
    if (strongSets !== Number(rule.stopStrongSets)) return false;
  }
  if (rule.stopWeakSets != null && rule.stopWeakSets !== '' && rule.stopWeakSets !== 'all') {
    if (weakSets !== Number(rule.stopWeakSets)) return false;
  }

  if (rule.stopWeakGamesMin != null && rule.stopWeakGamesMin !== '' && rule.stopWeakGamesMin !== 'all') {
    if (current.weak < Number(rule.stopWeakGamesMin)) return false;
  }

  if (!gamesTrailStop(current.strong, current.weak, rule.stopGameLead)) return false;
  return true;
}

function matchStopGroup(m, side, group) {
  if (group.stopEnabled === false) return false;
  let rules = Array.isArray(group.stopRules) ? group.stopRules : [];
  if (!rules.length && (group.stopFormat != null || group.stopSetIndex != null)) {
    rules = [group];
  }
  if (!rules.length) return false;
  return tennisConditionApply.evalGroupsChain(rules, (r) => matchStopRule(m, side, r));
}

/** 启用止损的组按 joinPrev 链求值；组内多条止损同样按 joinPrev */
function shouldStopLoss(m, rankings, groups) {
  const side = pickStrongSide(m, rankings);
  if (!side) return null;
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g.stopEnabled !== false);
  if (!list.length) return null;
  const hit = tennisConditionApply.evalGroupsChain(list, (g) => matchStopGroup(m, side, g));
  return hit ? side : null;
}

function flattenPrematchMatches(bundle) {
  const tournaments = bundle?.scheduled?.tournaments || [];
  return tournaments.flatMap((t) =>
    (t.events || []).map((e) => ({
      ...e,
      tournament: e.tournament || t.name,
      level: e.level || t.level,
    })),
  );
}

async function runBucketPass({
  bucketKey,
  product,
  bundle,
  stopGroups,
  entryGroups,
  uidNum,
  stake,
  state,
}) {
  const uid = String(uidNum);
  ensureUidState(state, uid);
  const placed = new Set((state.placed[uid][product] || []).map(String));
  const sold = new Set((state.sold[uid][product] || []).map(String));
  const rankings = bundle.rankingsByPlayer || {};

  const matches = bucketKey === 'prematch'
    ? flattenPrematchMatches(bundle)
    : (bundle.live?.matches || []);

  const sellOrders = [];
  const buyOrders = [];

  if (bucketKey === 'inplay') {
    for (const m of matches) {
      const id = String(m.id);
      if (!placed.has(id) || sold.has(id)) continue;
      const side = shouldStopLoss(m, rankings, stopGroups);
      if (side) sellOrders.push({ eventId: m.id, side });
    }
  }

  let soldOk = 0;
  for (const order of sellOrders) {
    try {
      await tennisTrade.placeSellOrder(uidNum, {
        eventId: order.eventId,
        side: order.side,
        shares: 'all',
        product,
      });
      sold.add(String(order.eventId));
      soldOk += 1;
    } catch (e) {
      console.warn('[betting] sell', product, order.eventId, e.message);
    }
  }

  for (const m of matches) {
    const id = String(m.id);
    if (placed.has(id) || sold.has(id)) continue;
    const side = pickStrongSide(m, rankings);
    if (!side) continue;
    if (!passesEntry(m, rankings, entryGroups, bundle)) continue;
    buyOrders.push({ eventId: m.id, side });
  }

  let bought = 0;
  if (buyOrders.length) {
    try {
      const result = await tennisTrade.placeBatchOrders(uidNum, {
        orders: buyOrders,
        amountUsd: stake,
        product,
      });
      for (const r of result.results || []) {
        if (r.ok) {
          placed.add(String(r.eventId));
          bought += 1;
        }
      }
    } catch (e) {
      console.warn('[betting] buy batch', product, e.message);
    }
  }

  state.placed[uid][product] = [...placed].slice(-500);
  state.sold[uid][product] = [...sold].slice(-500);

  return {
    bucket: bucketKey,
    product,
    sold: soldOk,
    bought,
    candidates: buyOrders.length,
  };
}

async function runBettingPass({
  amountUsd = 1,
  userId,
  onlyBucket = null,
  onlyGroupIndex = null,
} = {}) {
  const cfg = await tennisEngines.getConfig();
  if (!cfg.betting?.enabled) {
    return { ok: false, skipped: true, reason: 'betting disabled' };
  }
  const uidNum = Number(
    userId
    || cfg.betting?.userId
    || process.env.TENNIS_BETTING_USER_ID
    || 0
  );
  // 兼容：仅配了登录邮箱时再解析一次
  let resolvedUid = uidNum;
  if (!resolvedUid && cfg.betting?.userAccount) {
    try {
      const pool = require('../db');
      const [[row]] = await pool.query(
        'SELECT id FROM users WHERE account=? LIMIT 1',
        [String(cfg.betting.userAccount).trim()]
      );
      resolvedUid = row?.id ? Number(row.id) : 0;
    } catch { /* ignore */ }
  }
  if (!resolvedUid) {
    return { ok: false, skipped: true, reason: 'no engine user (betting.userAccount / userId)' };
  }

  const stake = Number(amountUsd || cfg.betting?.amountUsd || process.env.TENNIS_BETTING_AMOUNT_USD || 1) || 1;
  const state = await loadState();
  const results = [];

  async function runOne(bucketKey, product) {
    const productService = require('./product');
    const bucketCfg = cfg.betting.buckets?.[bucketKey];
    if (!bucketCfg?.enabled && onlyGroupIndex == null) return;
    if (onlyBucket && onlyBucket !== bucketKey) return;
    let stopGroups = bucketCfg?.groups || [];
    if (onlyGroupIndex != null) {
      const g = stopGroups[onlyGroupIndex];
      if (!g) return;
      stopGroups = [g];
    }

    const onlineProduct = await productService.findOnlineProductForBucket(bucketKey);
    const condLib = cfg.condition?.buckets?.[bucketKey]?.groups || [];
    const entryGroups = onlineProduct
      ? tennisConditionApply.resolveGroupsFromProductSelect(condLib, onlineProduct.bettingSelect)
      : [];
    if (!stopGroups.length && !entryGroups.length) return;

    let bundle = bucketKey === 'inplay'
      ? await tennisInplayCache.getBundle()
      : await tennisPrematchCache.getBundle();
    if (!bundle) return;
    results.push(await runBucketPass({
      bucketKey,
      product,
      bundle,
      stopGroups,
      entryGroups,
      uidNum: resolvedUid,
      stake,
      state,
    }));
  }

  await runOne('inplay', 'tennis-inplay');
  await runOne('prematch', 'tennis-prematch');

  await saveState(state);

  if (!results.length) {
    return { ok: false, skipped: true, reason: 'no betting bucket enabled or empty bundles' };
  }

  return {
    ok: true,
    userId: resolvedUid,
    userAccount: cfg.betting?.userAccount || null,
    sold: results.reduce((n, r) => n + (r.sold || 0), 0),
    bought: results.reduce((n, r) => n + (r.bought || 0), 0),
    candidates: results.reduce((n, r) => n + (r.candidates || 0), 0),
    buckets: results,
    onlyBucket,
    onlyGroupIndex,
  };
}

module.exports = {
  runBettingPass,
  loadState,
  saveState,
  shouldStopLoss,
  passesEntry,
};
