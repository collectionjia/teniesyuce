/**
 * 条件引擎：桶开关 + 产品挂载条件组（AND/OR）筛 matches
 */
function currentRank(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId;
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null;
  const n = Number(fromMap?.current ?? player?.ranking ?? player?.currentRank);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function bestRank(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId;
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null;
  const n = Number(fromMap?.best ?? player?.bestRank ?? player?.best);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function rankMetrics(m, rankingsByPlayer = {}) {
  const home = m?.homePlayer || { name: m?.home };
  const away = m?.awayPlayer || { name: m?.away };
  const homeR = currentRank(home, rankingsByPlayer);
  const awayR = currentRank(away, rankingsByPlayer);
  if (homeR == null || awayR == null) return { ready: false };
  const homeStronger = homeR < awayR;
  const strongRank = homeStronger ? homeR : awayR;
  const weakRank = homeStronger ? awayR : homeR;
  const strongBest = bestRank(homeStronger ? home : away, rankingsByPlayer);
  const weakBest = bestRank(homeStronger ? away : home, rankingsByPlayer);
  return {
    ready: true,
    gap: weakRank - strongRank,
    // 排差 = 弱者历史最高排名 − 强者现排名
    rankDiff: weakBest != null ? weakBest - strongRank : null,
    strongRank,
    weakRank,
    weakBest,
    strongBest,
  };
}

function tourOf(m) {
  return (m.tour || ((m.gender || m.homePlayer?.gender || m.awayPlayer?.gender) === 'F' ? 'WTA' : 'ATP')).toUpperCase();
}

function hasPm(m, polymarketByEvent = {}) {
  const id = m?.id;
  if (id == null) return false;
  const p = polymarketByEvent[String(id)] || polymarketByEvent[id];
  return !!(p?.url || m?.polymarketUrl);
}

function passTour(m, tour) {
  if (!tour || tour === 'all') return true;
  const t = tourOf(m);
  if (tour === '男' || tour === 'ATP') return t === 'ATP';
  if (tour === '女' || tour === 'WTA') return t === 'WTA';
  return t === String(tour).toUpperCase();
}

function passPm(m, pm, poly) {
  if (!pm || pm === 'all') return true;
  const ok = hasPm(m, poly);
  return pm === 'yes' ? ok : !ok;
}

function isLimited(v) {
  return v != null && v !== '' && v !== 'all';
}

function scoreSide(m, side) {
  return side === 'home'
    ? (m.homeScore || m.home_score || m.score?.home || {})
    : (m.awayScore || m.away_score || m.score?.away || {});
}

function periodScore(block, i) {
  if (block == null || typeof block !== 'object') return null;
  const n = Number(
    block[`period${i}`]
    ?? block[`set${i}`]
    ?? (Array.isArray(block.periods) ? block.periods[i - 1] : null),
  );
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

function pickStrongSide(m, rankingsByPlayer = {}) {
  const metrics = rankMetrics(m, rankingsByPlayer);
  if (!metrics.ready) return null;
  const home = m?.homePlayer || { name: m?.home };
  const away = m?.awayPlayer || { name: m?.away };
  const homeR = currentRank(home, rankingsByPlayer);
  const awayR = currentRank(away, rankingsByPlayer);
  if (homeR == null || awayR == null) return null;
  return homeR < awayR ? 'home' : 'away';
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
  return Math.max(h, a) === pair.hi && Math.min(h, a) === pair.lo;
}

/** 首盘局分是否命中排除形（如 7:5，顺序无关） */
function firstSetMatchesExcludeScore(m, excludeRaw) {
  return setMatchesExcludeScore(m, 1, excludeRaw);
}

/** 单组：字段全部 AND */
function passGroup(m, group, bundle) {
  const rules = group || {};
  const rankings = bundle?.rankingsByPlayer || {};
  const poly = bundle?.polymarketByEvent || {};
  if (!passTour(m, rules.tour)) return false;
  if (!passPm(m, rules.pm, poly)) return false;
  const metrics = rankMetrics(m, rankings);
  if (isLimited(rules.strongRankMax)) {
    if (!metrics.ready || metrics.strongRank > Number(rules.strongRankMax)) return false;
  }
  // 开区间：如 0 < x < 10、9 < x < 21
  if (isLimited(rules.strongRankGt)) {
    if (!metrics.ready || !(metrics.strongRank > Number(rules.strongRankGt))) return false;
  }
  if (isLimited(rules.strongRankLt)) {
    if (!metrics.ready || !(metrics.strongRank < Number(rules.strongRankLt))) return false;
  }
  if (isLimited(rules.gapMin)) {
    if (!metrics.ready || metrics.gap < Number(rules.gapMin)) return false;
  }
  if (isLimited(rules.rankDiffMin)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff < Number(rules.rankDiffMin)) return false;
  }
  if (isLimited(rules.rankDiffMax)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff > Number(rules.rankDiffMax)) return false;
  }
  if (rules.requireWonFirstSet
    || (rules.setGapMin != null && rules.setGapMin !== '' && rules.setGapMin !== 'all' && Number.isFinite(Number(rules.setGapMin)))) {
    const side = pickStrongSide(m, rankings);
    const setIdx = Number(rules.wonSetIndex);
    const wonSet = Number.isFinite(setIdx) ? Math.max(1, Math.min(5, Math.round(setIdx))) : 1;
    if (!side) return false;
    if (rules.setGapMin != null && rules.setGapMin !== '' && rules.setGapMin !== 'all' && Number.isFinite(Number(rules.setGapMin))) {
      const gap = setGameGap(m, side, wonSet);
      if (gap == null || !(gap > Number(rules.setGapMin))) return false;
    } else if (!strongWonSet(m, side, wonSet)) {
      return false;
    }
    if (rules.firstSetExcludeEnabled) {
      const excludeRaw = rules.firstSetExcludeScore != null
        ? String(rules.firstSetExcludeScore).trim()
        : '7:5';
      if (excludeRaw && setMatchesExcludeScore(m, wonSet, excludeRaw || '7:5')) return false;
    }
  }
  return true;
}

/** 多组按 joinPrev 左结合：and / or（默认 or，兼容旧版「任一组」） */
function evalGroupsChain(groups, passFn) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return false;
  let ok = !!passFn(list[0], 0);
  for (let i = 1; i < list.length; i++) {
    const join = String(list[i]?.joinPrev || 'or').toLowerCase() === 'and' ? 'and' : 'or';
    const p = !!passFn(list[i], i);
    ok = join === 'and' ? (ok && p) : (ok || p);
  }
  return ok;
}

/** 多组：joinPrev 链；无有效组则不过滤（原样返回） */
function filterMatchList(matches, bucketOrRules, bundle) {
  const list = Array.isArray(matches) ? matches : [];
  let groups = [];
  if (bucketOrRules && Array.isArray(bucketOrRules.groups)) {
    groups = bucketOrRules.groups;
  } else if (bucketOrRules && typeof bucketOrRules === 'object') {
    groups = [bucketOrRules];
  }
  if (!groups.length) return list;
  return list.filter((m) => evalGroupsChain(groups, (g) => passGroup(m, g, bundle)));
}

function countPrematchEvents(bundle) {
  const tournaments = bundle?.scheduled?.tournaments || [];
  return tournaments.reduce((n, t) => n + ((t.events || []).length), 0);
}

function applyToPrematchBundle(bundle, bucket) {
  if (!bundle || !bucket) return bundle;
  const poolCount = countPrematchEvents(bundle);
  const tournaments = (bundle.scheduled?.tournaments || []).map((t) => ({
    ...t,
    events: filterMatchList(t.events || [], bucket, bundle),
  })).filter((t) => (t.events || []).length);
  const eventCount = tournaments.reduce((n, t) => n + (t.events?.length || 0), 0);
  return {
    ...bundle,
    scheduled: { tournaments, tournamentCount: tournaments.length, eventCount },
    events: eventCount,
    condition_applied: true,
    condition_pool_count: poolCount,
    condition_matched_count: eventCount,
  };
}

function applyToInplayBundle(bundle, bucket) {
  if (!bundle || !bucket) return bundle;
  const pool = bundle.live?.matches || [];
  const poolCount = pool.length;
  const matches = filterMatchList(pool, bucket, bundle);
  return {
    ...bundle,
    live: {
      ...(bundle.live || {}),
      matches,
      eventCount: matches.length,
    },
    events: matches.length,
    condition_applied: true,
    condition_pool_count: poolCount,
    condition_matched_count: matches.length,
  };
}

/**
 * 条件引擎：桶开关 + 条件组筛 matches
 * 盘前用「关联未开赛」组；盘中/盘后用产品 condition_select 挂载
 */

function resolveGroupsFromProductSelect(libraryGroups, selectRows) {
  const lib = Array.isArray(libraryGroups) ? libraryGroups : [];
  const byId = new Map(lib.filter((g) => g?.id != null).map((g) => [String(g.id), g]));
  const rows = Array.isArray(selectRows) ? selectRows : [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = row?.id != null ? String(row.id) : '';
    const def = byId.get(id);
    if (!def) continue;
    const join = String(row.joinPrev || 'or').toLowerCase() === 'and' ? 'and' : 'or';
    out.push({
      ...def,
      joinPrev: i === 0 ? 'or' : join,
    });
  }
  return out;
}

function linkedGroupsForBucket(bucketKey, library) {
  const list = Array.isArray(library) ? library : [];
  if (bucketKey === 'prematch') return list.filter((g) => g?.linkPrematch === true);
  return list;
}

async function resolveBucketFilterGroups(bucketKey, productId = null) {
  const tennisEngines = require('./tennisEngines');
  const productService = require('./product');
  // 列表过滤：条件规则优先从 Redis 读（保存时已镜像），再对 Redis 赛程包做内存筛选
  const cfg = await tennisEngines.getConfigPreferRedis();
  const bucket = cfg.condition?.buckets?.[bucketKey];
  if (!bucket?.enabled) {
    return { ok: false, reason: 'bucket_off', cfg, bucket, groups: [] };
  }
  const library = bucket.groups || [];
  let product = null;
  if (productId) {
    product = await productService.findProductById(productId);
  } else {
    product = await productService.findOnlineProductForBucket(bucketKey);
  }
  // 盘前：勾选「关联未开赛」即生效，无需产品再选用
  if (bucketKey === 'prematch') {
    const groups = linkedGroupsForBucket(bucketKey, library);
    return {
      ok: true,
      cfg,
      bucket,
      product,
      groups,
      source: groups.length ? 'engine_library_linked' : (productId ? 'product_no_selection' : 'no_groups'),
    };
  }
  // 盘中/盘后：产品已挂载条件组 → 用挂载；无有效挂载则不筛
  if (product && Array.isArray(product.conditionSelect) && product.conditionSelect.length) {
    const groups = resolveGroupsFromProductSelect(library, product.conditionSelect);
    if (groups.length) {
      return {
        ok: true,
        cfg,
        bucket,
        product,
        groups,
        source: 'product_condition_select',
      };
    }
  }
  return {
    ok: true,
    cfg,
    bucket,
    product,
    groups: [],
    source: productId ? 'product_no_selection' : 'no_groups',
  };
}

async function maybeApplyCondition(product, bundle, productId = null) {
  const resolved = await resolveBucketFilterGroups(product, productId);
  if (!resolved.ok) {
    return {
      ...bundle,
      condition_enabled: false,
      condition_bucket: product,
      condition_skip: resolved.reason,
    };
  }
  const filterBucket = { enabled: true, groups: resolved.groups };
  let next = bundle;
  if (!resolved.groups.length) {
    return {
      ...bundle,
      condition_enabled: true,
      condition_bucket: product,
      condition_source: resolved.source,
      condition_applied: false,
      condition_skip: resolved.source === 'no_groups' ? 'no_groups' : null,
      admin_condition_rules: filterBucket,
    };
  }
  if (product === 'prematch') next = applyToPrematchBundle(bundle, filterBucket);
  else if (product === 'inplay' || product === 'settled') next = applyToInplayBundle(bundle, filterBucket);
  const groupNames = resolved.groups.map((g, i) => {
    const n = String(g?.name || '').trim();
    return n || `条件组 ${i + 1}`;
  });
  return {
    ...next,
    condition_enabled: true,
    condition_bucket: product,
    condition_source: resolved.source,
    condition_product_id: resolved.product?.id || null,
    condition_group_names: groupNames,
    admin_condition_rules: filterBucket,
  };
}

module.exports = {
  maybeApplyCondition,
  filterMatchList,
  applyToPrematchBundle,
  applyToInplayBundle,
  passGroup,
  evalGroupsChain,
  rankMetrics,
  resolveGroupsFromProductSelect,
  resolveBucketFilterGroups,
};
