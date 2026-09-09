/**
 * 条件引擎：按桶 enabled + 多组 OR（组内 AND）筛 matches
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
  const weakBest = bestRank(homeStronger ? away : home, rankingsByPlayer);
  return {
    ready: true,
    gap: weakRank - strongRank,
    rankDiff: weakBest != null ? strongRank - weakBest : null,
    strongRank,
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

function requiredTierGap(strongRank) {
  const r = Number(strongRank);
  if (!Number.isFinite(r) || r <= 0) return Infinity;
  if (r <= 10) return 20;
  if (r <= 20) return 30;
  if (r <= 50) return 50;
  if (r <= 100) return 150;
  return Infinity;
}

function isLimited(v) {
  return v != null && v !== '' && v !== 'all';
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
  if (isLimited(rules.gapMin)) {
    if (!metrics.ready || metrics.gap < Number(rules.gapMin)) return false;
  }
  if (isLimited(rules.rankDiffMin)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff < Number(rules.rankDiffMin)) return false;
  }
  if (isLimited(rules.rankDiffMax)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff > Number(rules.rankDiffMax)) return false;
  }
  if (rules.gapMode === 'tier') {
    if (!metrics.ready || metrics.gap < requiredTierGap(metrics.strongRank)) return false;
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

function applyToPrematchBundle(bundle, bucket) {
  if (!bundle || !bucket) return bundle;
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
  };
}

function applyToInplayBundle(bundle, bucket) {
  if (!bundle || !bucket) return bundle;
  const matches = filterMatchList(bundle.live?.matches || [], bucket, bundle);
  return {
    ...bundle,
    live: {
      ...(bundle.live || {}),
      matches,
      eventCount: matches.length,
    },
    events: matches.length,
    condition_applied: true,
  };
}

async function maybeApplyCondition(product, bundle) {
  const tennisEngines = require('./tennisEngines');
  const cfg = await tennisEngines.getConfig();
  const bucket = cfg.condition?.buckets?.[product];
  // 桶级单独打开；兼容旧全局 enabled：全局关则全部不套用
  if (!cfg.condition?.enabled) {
    return { ...bundle, condition_enabled: false };
  }
  if (!bucket?.enabled) {
    return { ...bundle, condition_enabled: false, condition_bucket: product };
  }
  let next = bundle;
  if (product === 'prematch') next = applyToPrematchBundle(bundle, bucket);
  else if (product === 'inplay' || product === 'settled') next = applyToInplayBundle(bundle, bucket);
  return {
    ...next,
    condition_enabled: true,
    admin_condition_rules: bucket,
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
};
