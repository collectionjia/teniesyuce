/**
 * 投注引擎：盘前 / 盘中分桶；买入条件组可 OR/AND；止损组相互隔离、组内止损条可 OR/AND
 * tick 后先止损再买入。
 */
const redis = require('./redis');
const tennisEngines = require('./tennisEngines');
const tennisInplayCache = require('./tennisInplayCache');
const tennisPrematchCache = require('./tennisPrematchCache');
const tennisTrade = require('./tennisTrade');
const tennisConditionApply = require('./tennisConditionApply');
const tennisDataSource = require('./tennisDataSource');
const tennisBettingExecLog = require('./tennisBettingExecLog');
const tennisThreeBuckets = require('./tennisThreeBuckets');
const { resolveInPlay, applyPmSettle } = require('./tennisInplayMatchQuery');

const STATE_KEY = 'tennis:engines:betting:state';

async function loadState() {
  const client = await redis.getClient();
  if (!client) {
    const err = new Error('betting state: Redis 不可用，拒绝扫描以免重复下单');
    err.code = 'STATE_REDIS';
    throw err;
  }
  try {
    const raw = await client.get(STATE_KEY);
    if (!raw) return { placed: {}, sold: {}, stakes: {} };
    const j = JSON.parse(raw);
    return { placed: j.placed || {}, sold: j.sold || {}, stakes: j.stakes || {} };
  } catch (e) {
    if (e?.code === 'STATE_REDIS') throw e;
    const err = new Error(`betting state read failed: ${e.message || e}`);
    err.code = 'STATE_REDIS';
    throw err;
  }
}

async function saveState(state) {
  const client = await redis.getClient();
  if (!client) {
    const err = new Error('betting state: Redis 不可用，无法保存去重状态');
    err.code = 'STATE_REDIS';
    throw err;
  }
  await client.set(STATE_KEY, JSON.stringify({
    placed: state.placed || {},
    sold: state.sold || {},
    stakes: state.stakes || {},
  }));
}

function ensureUidState(state, uid) {
  if (!state.stakes) state.stakes = {};
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
  if (!state.stakes[uid] || typeof state.stakes[uid] !== 'object') {
    state.stakes[uid] = { 'tennis-prematch': {}, 'tennis-inplay': {} };
  }
  if (!state.placed[uid]['tennis-prematch']) state.placed[uid]['tennis-prematch'] = [];
  if (!state.placed[uid]['tennis-inplay']) state.placed[uid]['tennis-inplay'] = [];
  if (!state.sold[uid]['tennis-prematch']) state.sold[uid]['tennis-prematch'] = [];
  if (!state.sold[uid]['tennis-inplay']) state.sold[uid]['tennis-inplay'] = [];
  if (!state.stakes[uid]['tennis-prematch']) state.stakes[uid]['tennis-prematch'] = {};
  if (!state.stakes[uid]['tennis-inplay']) state.stakes[uid]['tennis-inplay'] = {};
}

/** 策略维度去重：同一策略同一场只买一次；其它策略仍可买同一场 */
function strategyEventKey(strategyKey, eventId) {
  const sk = String(strategyKey || '').trim() || '_';
  return `${sk}::${String(eventId)}`;
}

function hasStrategyEvent(set, strategyKey, eventId) {
  return set.has(strategyEventKey(strategyKey, eventId));
}

/** 旧版仅存 eventId：止损仍认；买入不再用它挡其它策略 */
function hasLegacyEvent(set, eventId) {
  return set.has(String(eventId));
}

function markStrategyEvent(set, strategyKey, eventId) {
  set.add(strategyEventKey(strategyKey, eventId));
}

function listStrategyKeysForEvent(placedSet, eventId) {
  const id = String(eventId);
  const out = [];
  for (const k of placedSet) {
    const s = String(k);
    if (s === id) {
      out.push('_');
      continue;
    }
    const sep = s.lastIndexOf('::');
    if (sep > 0 && s.slice(sep + 2) === id) out.push(s.slice(0, sep));
  }
  return [...new Set(out)];
}

function setStakeShares(state, uid, product, strategyKey, eventId, shares) {
  ensureUidState(state, uid);
  const n = Number(shares);
  if (!(n > 0)) return;
  state.stakes[uid][product][strategyEventKey(strategyKey, eventId)] = Math.round(n * 10000) / 10000;
}

function getStakeShares(state, uid, product, strategyKey, eventId) {
  ensureUidState(state, uid);
  const n = Number(state.stakes[uid][product][strategyEventKey(strategyKey, eventId)]);
  return n > 0 ? n : null;
}

function clearStakeShares(state, uid, product, strategyKey, eventId) {
  ensureUidState(state, uid);
  delete state.stakes[uid][product][strategyEventKey(strategyKey, eventId)];
}

/** 只接受真实份数；有价时可用金额换算；禁止把 USD 直接当 shares */
function resolveStakeShares(o = {}) {
  const direct = Number(o.shares ?? o.takingAmount ?? o.taking_amount);
  if (direct > 0) return Math.round(direct * 10000) / 10000;
  const usd = Number(o.amountUsd ?? o.amount_usd);
  const px = Number(o.price);
  if (usd > 0 && px > 0) return Math.round((usd / px) * 10000) / 10000;
  return null;
}

/** 卖出后：本策略记 sold；若卖的是全部仓位则同场所有策略一并 sold */
function markSoldAfterSell(placed, sold, state, uid, product, strategyKey, eventId, soldAll) {
  markStrategyEvent(sold, strategyKey, eventId);
  clearStakeShares(state, uid, product, strategyKey, eventId);
  if (soldAll) {
    for (const sk of listStrategyKeysForEvent(placed, eventId)) {
      markStrategyEvent(sold, sk, eventId);
      clearStakeShares(state, uid, product, sk, eventId);
    }
    sold.add(String(eventId));
  }
}

/**
 * UI / 手动批量下单成功后写入去重状态，避免调度引擎再买一次
 */
async function markPlacedFromOrders({
  userId,
  product,
  strategyKey,
  orders = [],
} = {}) {
  const uid = String(Number(userId) || 0);
  if (!uid || uid === '0') return { ok: false, error: 'missing userId' };
  const prod = String(product || '').toLowerCase();
  if (!['tennis-prematch', 'tennis-inplay'].includes(prod)) {
    return { ok: false, error: 'invalid product' };
  }
  const sk = String(strategyKey || '').trim() || '_';
  const state = await loadState();
  ensureUidState(state, uid);
  const placed = new Set((state.placed[uid][prod] || []).map(String));
  let n = 0;
  for (const o of orders) {
    const id = String(o?.eventId || '').trim();
    if (!id) continue;
    markStrategyEvent(placed, sk, id);
    const shares = resolveStakeShares(o);
    if (shares > 0) setStakeShares(state, uid, prod, sk, id, shares);
    n += 1;
  }
  state.placed[uid][prod] = [...placed].slice(-2000);
  await saveState(state);
  return { ok: true, marked: n, strategyKey: sk, product: prod };
}

/**
 * UI 手动卖出后写入 sold，避免调度止损重复卖
 * orders: [{ eventId, soldAll?, shares? }]
 */
async function markSoldFromOrders({
  userId,
  product,
  strategyKey,
  orders = [],
} = {}) {
  const uid = String(Number(userId) || 0);
  if (!uid || uid === '0') return { ok: false, error: 'missing userId' };
  const prod = String(product || '').toLowerCase();
  if (!['tennis-prematch', 'tennis-inplay'].includes(prod)) {
    return { ok: false, error: 'invalid product' };
  }
  const state = await loadState();
  ensureUidState(state, uid);
  const placed = new Set((state.placed[uid][prod] || []).map(String));
  const sold = new Set((state.sold[uid][prod] || []).map(String));
  const preferSk = String(strategyKey || '').trim();
  let n = 0;
  for (const o of orders) {
    const id = String(o?.eventId || '').trim();
    if (!id) continue;
    let soldAll = o.soldAll === true || o.shares === 'all' || o.shares === 'ALL';
    let sk = preferSk;
    if (!sk) {
      const keys = listStrategyKeysForEvent(placed, id).filter((k) => k && k !== '_');
      const sh = resolveStakeShares(o);
      if (keys.length === 1) {
        sk = keys[0];
      } else if (sh > 0 && keys.length > 1) {
        let best = null;
        let bestDiff = Infinity;
        for (const k of keys) {
          const tracked = getStakeShares(state, uid, prod, k, id);
          if (!(tracked > 0)) continue;
          const diff = Math.abs(tracked - sh);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = k;
          }
        }
        if (best != null && bestDiff <= Math.max(0.05, sh * 0.08)) sk = best;
      }
      if (!sk) {
        // 无法归因到单一策略：按整场已平，避免止损反复扫
        soldAll = true;
        sk = keys[0] || '_';
      }
    }
    markSoldAfterSell(placed, sold, state, uid, prod, sk, id, soldAll);
    n += 1;
  }
  state.placed[uid][prod] = [...placed].slice(-2000);
  state.sold[uid][prod] = [...sold].slice(-2000);
  await saveState(state);
  return { ok: true, marked: n, strategyKey: preferSk || null, product: prod };
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

function strongWonSet(m, side, setIndex = 1) {
  const idx = Number(setIndex);
  const i = Number.isFinite(idx) ? Math.max(1, Math.min(5, Math.round(idx))) : 1;
  const hs = scoreSide(m, 'home');
  const as = scoreSide(m, 'away');
  const h = periodScore(hs, i);
  const a = periodScore(as, i);
  if (h == null || a == null || h === a) return false;
  if (!isSetComplete(h, a)) return false;
  const homeWon = h > a;
  return side === 'home' ? homeWon : !homeWon;
}

/** 指定盘：强方局分 − 弱方局分；缺分返回 null */
function setGameGap(m, side, setIndex = 1) {
  const idx = Number(setIndex);
  const i = Number.isFinite(idx) ? Math.max(1, Math.min(5, Math.round(idx))) : 1;
  const hs = scoreSide(m, 'home');
  const as = scoreSide(m, 'away');
  const h = periodScore(hs, i);
  const a = periodScore(as, i);
  if (h == null || a == null) return null;
  const strong = side === 'home' ? h : a;
  const weak = side === 'home' ? a : h;
  return strong - weak;
}

function strongWonFirstSet(m, side) {
  return strongWonSet(m, side, 1);
}

/** 盘中投注引擎 entry：第几盘盘差（强−弱 > N）+ PM¢ */
function passesInplayEngineEntry(m, rankings, entryCfg, bundle, side) {
  const tennisEngines = require('./tennisEngines');
  const e = tennisEngines.normalizeInplayBettingEntry(entryCfg);
  const homeR = currentRank(m.homePlayer || { name: m.home }, rankings);
  const awayR = currentRank(m.awayPlayer || { name: m.away }, rankings);
  if (homeR == null || awayR == null) return false;
  const setIdx = e.wonSetIndex || 1;
  if (e.setGapMin != null && e.setGapMin !== '' && e.setGapMin !== 'all') {
    const gap = setGameGap(m, side, setIdx);
    if (gap == null || !(gap > Number(e.setGapMin))) return false;
  } else if (e.requireWonFirstSet) {
    // 旧配置兜底：须赢指定盘
    if (!strongWonSet(m, side, setIdx)) return false;
  }
  if (e.requireWonFirstSet && e.firstSetExcludeEnabled) {
    const excludeRaw = e.firstSetExcludeScore != null && String(e.firstSetExcludeScore).trim()
      ? String(e.firstSetExcludeScore).trim()
      : '7:5';
    if (setMatchesExcludeScore(m, setIdx, excludeRaw)) return false;
  }
  if (e.pmCentsMax != null && e.pmCentsMax !== '' && e.pmCentsMax !== 'all') {
    const cents = strongPolyCents(m, bundle, side);
    if (cents != null && !(cents < Number(e.pmCentsMax))) return false;
  }
  return true;
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

/** 指定盘局分是否命中排除形（如 7:5，顺序无关） */
function setMatchesExcludeScore(m, setIndex, excludeRaw) {
  const pair = parseGameScorePair(excludeRaw);
  if (!pair) return false;
  const idx = Number(setIndex);
  const i = Number.isFinite(idx) ? Math.max(1, Math.min(5, Math.round(idx))) : 1;
  const hs = scoreSide(m, 'home');
  const as = scoreSide(m, 'away');
  const h = periodScore(hs, i);
  const a = periodScore(as, i);
  if (h == null || a == null) return false;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  return hi === pair.hi && lo === pair.lo;
}

/** 首盘局分是否命中排除形（如 7:5，顺序无关） */
function firstSetMatchesExcludeScore(m, excludeRaw) {
  return setMatchesExcludeScore(m, 1, excludeRaw);
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
  return strongG < weakG && weakG - strongG >= n;
}

/** 买入：产品 betting_select 解析出的条件组链（组内 AND，组间 joinPrev） */
function passesEntry(m, rankings, entryGroups, bundle) {
  const list = Array.isArray(entryGroups) ? entryGroups : [];
  if (!list.length) return false;
  return tennisConditionApply.evalGroupsChain(list, (g) => tennisConditionApply.passGroup(m, g, bundle));
}

function matchStopRule(m, side, rule, bundle) {
  const pmMaxRaw = rule.stopPmCentsMax;
  const pmMax = Number(pmMaxRaw);
  // 未设置 / 场次无赔率 → 不把 PM 计入条件
  const wantPm = pmMaxRaw != null && pmMaxRaw !== '' && pmMaxRaw !== 'all'
    && Number.isFinite(pmMax) && pmMax > 0;
  let applyPm = false;
  let pmOk = true;
  if (wantPm) {
    const cents = strongPolyCents(m, bundle, side);
    if (cents != null) {
      applyPm = true;
      pmOk = cents < pmMax;
    }
  }

  const fmt = String(rule.stopFormat || 'any').toLowerCase();
  const hasFormat = fmt === 'bo3' || fmt === 'bo5';
  const setIndex = Number(rule.stopSetIndex);
  const hasSetIndex = Number.isFinite(setIndex) && setIndex > 0 && rule.stopSetIndex !== '' && rule.stopSetIndex !== 'all';
  const hasStrongSets = rule.stopStrongSets != null && rule.stopStrongSets !== '' && rule.stopStrongSets !== 'all';
  const hasWeakSets = rule.stopWeakSets != null && rule.stopWeakSets !== '' && rule.stopWeakSets !== 'all';
  const lead = rule.stopGameLead;
  const hasTrail = !(lead == null || lead === '' || lead === 'all');
  // 局差与 PM 作为整体 OR；弱方局分已弃用
  const hasAnyConstraint = applyPm || hasFormat || hasSetIndex || hasStrongSets || hasWeakSets || hasTrail;
  if (!hasAnyConstraint) return false;

  const { strongSets, weakSets, current } = analyzeSets(m, side);
  if (!current) {
    return applyPm && pmOk;
  }

  const bo5 = isBo5(m);
  if (fmt === 'bo3' && bo5) return false;
  if (fmt === 'bo5' && !bo5) return false;

  if (hasSetIndex && current.setIndex !== setIndex) return false;

  if (hasStrongSets) {
    if (strongSets !== Number(rule.stopStrongSets)) return false;
  }
  if (hasWeakSets) {
    if (weakSets !== Number(rule.stopWeakSets)) return false;
  }

  if (hasTrail || applyPm) {
    const trailOk = hasTrail ? gamesTrailStop(current.strong, current.weak, lead) : false;
    const pOk = applyPm ? pmOk : false;
    if (hasTrail && applyPm) {
      if (!(trailOk || pOk)) return false;
    } else if (hasTrail) {
      if (!trailOk) return false;
    } else if (!pOk) {
      return false;
    }
  }
  return true;
}

function matchStopGroup(m, side, group, bundle) {
  if (group.stopEnabled === false) return false;
  let rules = Array.isArray(group.stopRules) ? group.stopRules : [];
  if (!rules.length && (group.stopFormat != null || group.stopSetIndex != null || group.stopPmCentsMax != null)) {
    rules = [group];
  }
  if (!rules.length) return false;
  return tennisConditionApply.evalGroupsChain(rules, (r) => matchStopRule(m, side, r, bundle));
}

/** 各止损组相互隔离：逐组独立评估，命中即触发（组间不用 joinPrev）；组内多条止损仍按 joinPrev */
function findStopTrigger(m, rankings, groups, bundle) {
  const side = pickStrongSide(m, rankings);
  if (!side) return null;
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g.stopEnabled !== false);
  for (const g of list) {
    if (matchStopGroup(m, side, g, bundle)) return { side, group: g };
  }
  return null;
}

function shouldStopLoss(m, rankings, groups, bundle) {
  const t = findStopTrigger(m, rankings, groups, bundle);
  return t ? t.side : null;
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

/** 盘中买入：排除已结束 / PM 已结算 / 非进行中（止损仍扫全量） */
function inplayEligibleForBuy(m, bundle) {
  const polyMap = bundle?.polymarketByEvent || {};
  const poly = polyMap[String(m?.id)] || polyMap[m?.id];
  const row = poly ? applyPmSettle({ ...m }, poly) : m;
  if (tennisThreeBuckets.isEnded(row)) return false;
  return resolveInPlay(row);
}

function matchLabel(m) {
  const home = m?.homePlayer?.name || m?.home || '?';
  const away = m?.awayPlayer?.name || m?.away || '?';
  return `${home} vs ${away}`;
}

function strategyKeysFromGroups(groups) {
  const keys = [];
  const seen = new Set();
  for (const g of groups || []) {
    const k = String(g?.strategyKey || g?.id || '').trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

function groupStrategyKey(g) {
  return String(g?.strategyKey || g?.id || '').trim();
}

function findStopGroupForKey(groups, sk) {
  const key = String(sk || '').trim();
  if (!key || key === '_') return null;
  return (groups || []).find((g) => groupStrategyKey(g) === key) || null;
}

async function runBucketPass({
  bucketKey,
  product,
  bundle,
  stopGroups,
  entryGroups,
  entryCfg,
  uidNum,
  stake,
  state,
  simulate = false,
  mode = 'both',
  onlyStrategyKey = null,
  allowEventIds = null,
  orderType = 'market',
  limitPrice = null,
  limitBuyPrice = null,
  limitSellPrice = null,
  shares = null,
}) {
  const uid = String(uidNum);
  ensureUidState(state, uid);
  const placed = new Set((state.placed[uid][product] || []).map(String));
  const sold = new Set((state.sold[uid][product] || []).map(String));
  const rankings = bundle.rankingsByPlayer || {};
  const isSim = !!simulate;
  const doStop = mode === 'both' || mode === 'stop';
  const doBuy = mode === 'both' || mode === 'buy';
  const at = new Date().toISOString();
  const strategyKeys = [
    ...new Set([
      ...strategyKeysFromGroups(entryGroups),
      ...strategyKeysFromGroups(stopGroups),
      ...(onlyStrategyKey ? [String(onlyStrategyKey)] : []),
    ]),
  ];
  const primarySk = onlyStrategyKey || strategyKeys[0] || '';
  const logItems = [];
  const MAX_MISS = 40;
  const allowSet = allowEventIds;

  const matches = bucketKey === 'prematch'
    ? flattenPrematchMatches(bundle)
    : (bundle.live?.matches || []);

  const sellOrders = [];
  const buyOrders = [];
  let stopChecked = 0;
  let stopMet = 0;
  let buyChecked = 0;
  let buyMet = 0;
  let buyMissLogged = 0;

  if (doStop && (bucketKey === 'inplay' || bucketKey === 'prematch')) {
    for (const m of matches) {
      const id = String(m.id);
      if (!matchInAllowSet(allowSet, id)) continue;
      let skList = listStrategyKeysForEvent(placed, id).filter((sk) => !hasStrategyEvent(sold, sk, id));
      if (!skList.length && hasLegacyEvent(placed, id) && !hasLegacyEvent(sold, id)) {
        skList = ['_'];
      }
      if (!skList.length) continue;
      for (const posSk of skList) {
        const owned = posSk === '_'
          ? hasLegacyEvent(placed, id)
          : hasStrategyEvent(placed, posSk, id);
        if (!owned) continue;
        const stopGroup = findStopGroupForKey(stopGroups, posSk);
        const activeStopGroups = stopGroup
          ? (stopGroup.stopEnabled === false ? [] : [stopGroup])
          : (posSk === '_' ? stopGroups.filter((g) => g.stopEnabled !== false) : []);
        if (!activeStopGroups.length) continue;
        stopChecked += 1;
        const logSk = posSk === '_'
          ? (groupStrategyKey(stopGroup) || groupStrategyKey(activeStopGroups[0]) || primarySk)
          : posSk;
        const trigger = findStopTrigger(m, rankings, activeStopGroups, bundle);
        if (trigger) {
          const sk = posSk === '_'
            ? (groupStrategyKey(trigger.group) || primarySk)
            : posSk;
          stopMet += 1;
          sellOrders.push({ eventId: m.id, side: trigger.side, match: m, strategyKey: sk });
        } else {
          logItems.push({
            at,
            type: 'stop',
            bucket: bucketKey,
            strategyKey: logSk,
            strategyKeys,
            eventId: id,
            match: matchLabel(m),
            met: false,
            action: 'none',
            detail: '持仓检查：止损条件不满足',
            simulated: isSim,
          });
        }
      }
    }
  }

  let soldOk = 0;
  for (const order of sellOrders) {
    const id = String(order.eventId);
    const sk = order.strategyKey || primarySk;
    const tracked = getStakeShares(state, uid, product, sk, id);
    // 有记下的份数则只卖本策略份额；否则只能卖全部并标记同场所有策略已平
    const sellShares = tracked > 0 ? tracked : 'all';
    const soldAll = sellShares === 'all';
    try {
      const sellRes = await tennisTrade.placeSellOrder(uidNum, {
        eventId: order.eventId,
        side: order.side,
        shares: sellShares,
        product,
        simulate: isSim,
        orderType,
        limitSellPrice,
        limitPrice: limitSellPrice ?? limitPrice,
      });
      markSoldAfterSell(placed, sold, state, uid, product, sk, id, soldAll);
      soldOk += 1;
      const price = sellRes?.price != null ? Number(sellRes.price) : null;
      const amountUsd = sellRes?.amountUsd != null ? Number(sellRes.amountUsd) : null;
      logItems.push({
        at,
        type: 'stop',
        bucket: bucketKey,
        strategyKey: sk,
        strategyKeys,
        eventId: id,
        match: matchLabel(order.match),
        met: true,
        action: 'sell',
        side: order.side,
        price: Number.isFinite(price) ? price : null,
        amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
        shares: sellRes?.soldShares ?? sellRes?.shares ?? sellShares,
        ok: true,
        detail: isSim
          ? `止损满足，模拟卖出 ${order.side}${soldAll ? '（全部）' : ` ${tracked}份`}`
          : `止损满足，卖出 ${order.side}${soldAll ? '（全部·同场策略一并平仓）' : ` ${tracked}份`}${Number.isFinite(price) ? ` @ ${price}` : ''}`,
        simulated: isSim,
      });
    } catch (e) {
      console.warn('[betting] sell', product, order.eventId, e.message);
      logItems.push({
        at,
        type: 'stop',
        bucket: bucketKey,
        strategyKey: sk,
        strategyKeys,
        eventId: id,
        match: matchLabel(order.match),
        met: true,
        action: 'sell',
        side: order.side,
        ok: false,
        error: e.message || String(e),
        detail: `止损满足，卖出失败：${e.message || e}`,
        simulated: isSim,
      });
    }
  }

  if (doBuy) {
    for (const m of matches) {
      const id = String(m.id);
      if (!matchInAllowSet(allowSet, id)) continue;
      if (bucketKey === 'inplay' && !inplayEligibleForBuy(m, bundle)) continue;
      // 仅挡「本策略已买/已卖」；其它策略对同一场仍可买
      if (hasStrategyEvent(placed, primarySk, id) || hasStrategyEvent(sold, primarySk, id)) continue;
      const side = pickStrongSide(m, rankings);
      if (!side) continue;
      buyChecked += 1;
      if (bucketKey === 'inplay' && !passesInplayEngineEntry(m, rankings, entryCfg, bundle, side)) {
        if (buyMissLogged < MAX_MISS) {
          buyMissLogged += 1;
          logItems.push({
            at,
            type: 'buy',
            bucket: bucketKey,
            strategyKey: primarySk,
            strategyKeys,
            eventId: id,
            match: matchLabel(m),
            met: false,
            action: 'none',
            detail: '买入附加条件不满足（如须赢首盘等）',
            simulated: isSim,
          });
        }
        continue;
      }
      if (!passesEntry(m, rankings, entryGroups, bundle)) {
        if (buyMissLogged < MAX_MISS) {
          buyMissLogged += 1;
          logItems.push({
            at,
            type: 'buy',
            bucket: bucketKey,
            strategyKey: primarySk,
            strategyKeys,
            eventId: id,
            match: matchLabel(m),
            met: false,
            action: 'none',
            detail: '投注条件不满足',
            simulated: isSim,
          });
        }
        continue;
      }
      buyMet += 1;
      buyOrders.push({ eventId: m.id, side, match: m, strategyKey: primarySk });
    }
  }

  let bought = 0;
  const buyById = new Map(buyOrders.map((o) => [String(o.eventId), o]));
  if (buyOrders.length) {
    try {
      const result = await tennisTrade.placeBatchOrders(uidNum, {
        orders: buyOrders.map(({ eventId, side, strategyKey }) => ({
          eventId,
          side,
          strategyKey,
          bucket: bucketKey,
        })),
        amountUsd: stake,
        product,
        simulate: isSim,
        strategyKey: primarySk,
        bucket: bucketKey,
        orderType,
        limitPrice: limitBuyPrice ?? limitPrice,
        limitBuyPrice: limitBuyPrice ?? limitPrice,
        shares,
      });
      for (const r of result.results || []) {
        const id = String(r.eventId);
        const ord = buyById.get(id);
        if (r.ok) {
          const skBuy = ord?.strategyKey || primarySk;
          markStrategyEvent(placed, skBuy, id);
          const sh = resolveStakeShares({
            shares: r.shares,
            takingAmount: r.takingAmount,
            amountUsd: r.amountUsd != null ? r.amountUsd : stake,
            price: r.price,
          });
          if (sh > 0) setStakeShares(state, uid, product, skBuy, id, sh);
          bought += 1;
        }
        const price = r.price != null ? Number(r.price) : (isSim ? 1 : null);
        logItems.push({
          at,
          type: 'buy',
          bucket: bucketKey,
          strategyKey: primarySk,
          strategyKeys,
          eventId: id,
          match: ord ? matchLabel(ord.match) : id,
          met: true,
          action: 'buy',
          side: r.side || ord?.side,
          amountUsd: r.amountUsd != null ? Number(r.amountUsd) : stake,
          price: Number.isFinite(price) ? price : null,
          ok: !!r.ok,
          error: r.error || null,
          detail: r.ok
            ? `条件满足，${orderType === 'limit' ? '限价挂单' : '买入'} $${r.amountUsd != null ? r.amountUsd : stake}${Number.isFinite(price) ? ` @ ${price}` : ''}`
            : `条件满足，${orderType === 'limit' ? '限价挂单' : '买入'}失败：${r.error || 'unknown'}`,
          simulated: isSim,
        });
      }
    } catch (e) {
      console.warn('[betting] buy batch', product, e.message);
      for (const ord of buyOrders) {
        logItems.push({
          at,
          type: 'buy',
          bucket: bucketKey,
          strategyKey: primarySk,
          strategyKeys,
          eventId: String(ord.eventId),
          match: matchLabel(ord.match),
          met: true,
          action: 'buy',
          side: ord.side,
          amountUsd: stake,
          ok: false,
          error: e.message || String(e),
          detail: `条件满足，批量买入失败：${e.message || e}`,
          simulated: isSim,
        });
      }
    }
  }

  state.placed[uid][product] = [...placed].slice(-2000);
  state.sold[uid][product] = [...sold].slice(-2000);

  logItems.unshift({
    at,
    type: 'run',
    bucket: bucketKey,
    strategyKey: primarySk,
    strategyKeys,
    mode,
    met: null,
    action: 'scan',
    detail: [
      doBuy ? `条件扫描 ${buyChecked} 场，满足 ${buyMet}，买入 ${bought}` : null,
      doStop ? `止损扫描 ${stopChecked} 场持仓，满足 ${stopMet}，卖出 ${soldOk}` : null,
      isSim ? '模拟' : '实盘',
    ].filter(Boolean).join('；'),
    buyChecked,
    buyMet,
    bought,
    stopChecked,
    stopMet,
    sold: soldOk,
    stake,
    simulated: isSim,
  });

  await tennisBettingExecLog.append(logItems);

  return {
    bucket: bucketKey,
    product,
    sold: soldOk,
    bought,
    candidates: buyOrders.length,
    simulated: isSim,
    mode,
  };
}

function filterByStrategyKey(groups, strategyKey) {
  const key = String(strategyKey || '').trim();
  if (!key) return groups || [];
  return (groups || []).filter((g) => String(g?.strategyKey || '').trim() === key);
}

/** null=不限制（自动从采集选赛）；Set=仅这些 eventId */
function resolveEventAllowSet(groups) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return null;
  const manual = list.some((g) => g && g.autoSelectFromCollect === false);
  if (!manual) return null;
  const ids = new Set();
  for (const g of list) {
    for (const id of g?.eventIds || []) {
      const s = String(id || '').trim();
      if (s) ids.add(s);
    }
  }
  return ids;
}

function matchInAllowSet(allowSet, eventId) {
  if (!allowSet) return true;
  return allowSet.has(String(eventId));
}

async function runBettingPass({
  amountUsd = 1,
  userId,
  onlyBucket = null,
  onlyGroupIndex = null,
  conditionGroupIndex = null,
  onlyStrategyKey = null,
  mode = 'both',
} = {}) {
  const cfg = await tennisEngines.getConfig();
  // 不再依赖投注总开关：各桶「打开」即投注
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

  const passMode = ['buy', 'stop', 'both'].includes(mode) ? mode : 'both';
  const fallbackStake = Number(amountUsd || cfg.betting?.amountUsd || process.env.TENNIS_BETTING_AMOUNT_USD || 1) || 1;
  let state;
  try {
    state = await loadState();
  } catch (e) {
    if (e?.code === 'STATE_REDIS') {
      return { ok: false, skipped: true, reason: e.message };
    }
    throw e;
  }
  const results = [];

  function stakeFromGroups(groups, fallback) {
    for (const g of groups || []) {
      const n = Number(g?.amountUsd);
      if (Number.isFinite(n) && n >= 1) return Math.round(n * 100) / 100;
    }
    return fallback;
  }

  async function runOne(bucketKey, product) {
    const productService = require('./product');
    const bucketCfg = cfg.betting?.buckets?.[bucketKey];
    // 止损可在桶关闭时仍检查持仓；买入要求桶打开（或指定组/策略）
    if (passMode !== 'stop' && !bucketCfg?.enabled && onlyGroupIndex == null && conditionGroupIndex == null && !onlyStrategyKey) return;
    if (passMode === 'buy' && !bucketCfg?.enabled && onlyGroupIndex == null && conditionGroupIndex == null && !onlyStrategyKey) return;
    if (onlyBucket && onlyBucket !== bucketKey) return;
    let stopGroupsAll = bucketCfg?.groups || [];
    if (onlyGroupIndex != null && passMode !== 'buy') {
      const g = stopGroupsAll[onlyGroupIndex];
      if (!g) return;
      stopGroupsAll = [g];
    }

    const onlineProduct = await productService.findOnlineProductForBucket(bucketKey);
    const condLib = cfg.condition?.buckets?.[bucketKey]?.groups || [];
    let entryGroupsAll = [];
    if (conditionGroupIndex != null && passMode === 'buy') {
      const g = condLib[conditionGroupIndex];
      if (!g) return;
      entryGroupsAll = [{ ...g, joinPrev: 'or' }];
    } else if (onlineProduct) {
      const betSel = Array.isArray(onlineProduct.bettingSelect) ? onlineProduct.bettingSelect : [];
      const condSel = Array.isArray(onlineProduct.conditionSelect) ? onlineProduct.conditionSelect : [];
      const sel = betSel.length ? betSel : condSel;
      if (sel.length) {
        entryGroupsAll = tennisConditionApply.resolveGroupsFromProductSelect(condLib, sel);
      }
    }
    if (!entryGroupsAll.length && Array.isArray(condLib) && condLib.length) {
      entryGroupsAll = condLib.map((g, i) => ({ ...g, joinPrev: i === 0 ? 'or' : (g.joinPrev || 'or') }));
    }

    // 按策略拆开跑，避免无 onlyStrategyKey 时全部记到第一个策略
    let skList = onlyStrategyKey
      ? [String(onlyStrategyKey)]
      : [...new Set([
          ...strategyKeysFromGroups(entryGroupsAll),
          ...strategyKeysFromGroups(stopGroupsAll),
        ])];
    if (!skList.length && conditionGroupIndex != null && entryGroupsAll.length === 1) {
      const cgSk = groupStrategyKey(entryGroupsAll[0]);
      if (cgSk) skList = [cgSk];
    }
    if (!skList.length) skList = [''];

    let bundle = bucketKey === 'inplay'
      ? await tennisInplayCache.getBundle()
      : await tennisPrematchCache.getBundle();
    if (!bundle) return;

    const ds = await tennisDataSource.get();
    // docks500 强制模拟；真实采集时尊重桶内 simulate
    const simulate = ds === 'docks500' || !!bucketCfg?.simulate;

    for (const sk of skList) {
      const stopGroups = sk
        ? filterByStrategyKey(stopGroupsAll, sk)
        : stopGroupsAll;
      let entryGroups = sk
        ? filterByStrategyKey(entryGroupsAll.length ? entryGroupsAll : condLib, sk)
        : entryGroupsAll;
      if (sk && !entryGroups.length && Array.isArray(condLib)) {
        entryGroups = filterByStrategyKey(condLib, sk);
      }
      if (!stopGroups.length && !entryGroups.length) continue;
      if (passMode === 'buy' && !bucketCfg?.enabled && conditionGroupIndex == null) continue;
      let effectiveMode = passMode;
      if (passMode === 'both' && !bucketCfg?.enabled && sk) {
        if (!stopGroups.length) continue;
        effectiveMode = 'stop';
      }
      const allowEventIds = resolveEventAllowSet([...(entryGroups || []), ...(stopGroups || [])]);
      results.push(await runBucketPass({
        bucketKey,
        product,
        bundle,
        stopGroups,
        entryGroups,
        entryCfg: bucketKey === 'inplay' ? bucketCfg?.entry : null,
        uidNum: resolvedUid,
        stake: stakeFromGroups(stopGroups.length ? stopGroups : entryGroups, Number(bucketCfg?.amountUsd) > 0 ? Number(bucketCfg.amountUsd) : fallbackStake),
        state,
        simulate,
        mode: effectiveMode,
        onlyStrategyKey: sk || null,
        allowEventIds,
        orderType: bucketCfg?.orderType || cfg.betting?.orderType || 'market',
        limitPrice: bucketCfg?.limitBuyPrice ?? bucketCfg?.limitPrice ?? cfg.betting?.limitBuyPrice ?? cfg.betting?.limitPrice,
        limitBuyPrice: bucketCfg?.limitBuyPrice ?? bucketCfg?.limitPrice ?? cfg.betting?.limitBuyPrice ?? cfg.betting?.limitPrice,
        limitSellPrice: bucketCfg?.limitSellPrice ?? cfg.betting?.limitSellPrice,
        shares: bucketCfg?.shares ?? cfg.betting?.shares,
      }));
    }
  }

  await runOne('inplay', 'tennis-inplay');
  await runOne('prematch', 'tennis-prematch');

  try {
    await saveState(state);
  } catch (e) {
    if (e?.code === 'STATE_REDIS') {
      return { ok: false, skipped: true, reason: e.message, partial: results };
    }
    throw e;
  }

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
    conditionGroupIndex,
    onlyStrategyKey: onlyStrategyKey || null,
    mode: passMode,
  };
}

/**
 * 订单改挂止损组：同步 Redis 持仓策略键
 */
async function reassignBettingStrategy({
  userId,
  product,
  eventId,
  strategyKey,
  oldStrategyKey = null,
} = {}) {
  const uid = String(Number(userId) || 0);
  const prod = String(product || '').toLowerCase();
  const id = String(eventId || '').trim();
  const newSk = String(strategyKey || '').trim();
  if (!uid || uid === '0' || !id || !newSk) {
    return { ok: false, error: 'missing userId/eventId/strategyKey' };
  }
  if (!['tennis-prematch', 'tennis-inplay'].includes(prod)) {
    return { ok: false, error: 'invalid product' };
  }
  const state = await loadState();
  ensureUidState(state, uid);
  const placed = new Set((state.placed[uid][prod] || []).map(String));
  const oldCandidates = oldStrategyKey
    ? [String(oldStrategyKey).trim()]
    : listStrategyKeysForEvent(placed, id);
  let moved = false;
  for (const oldSk of oldCandidates) {
    if (!oldSk || oldSk === newSk) continue;
    if (!hasStrategyEvent(placed, oldSk, id) && !(oldSk === '_' && hasLegacyEvent(placed, id))) continue;
    const shares = getStakeShares(state, uid, prod, oldSk, id);
    if (oldSk !== '_') {
      placed.delete(strategyEventKey(oldSk, id));
    } else {
      placed.delete(id);
    }
    clearStakeShares(state, uid, prod, oldSk, id);
    markStrategyEvent(placed, newSk, id);
    if (shares > 0) setStakeShares(state, uid, prod, newSk, id, shares);
    moved = true;
    break;
  }
  if (!moved) {
    markStrategyEvent(placed, newSk, id);
  }
  state.placed[uid][prod] = [...placed].slice(-2000);
  await saveState(state);
  return { ok: true, strategyKey: newSk, product: prod, eventId: id };
}

module.exports = {
  runBettingPass,
  loadState,
  saveState,
  markPlacedFromOrders,
  markSoldFromOrders,
  reassignBettingStrategy,
  shouldStopLoss,
  passesEntry,
};
