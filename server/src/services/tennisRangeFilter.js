/** 区间网球：任一方 Top100 + 按强者排名分档的最小现差 */

const TOP_RANK_MAX = 100;

function currentRankOf(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId;
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null;
  const raw = fromMap?.current ?? player?.ranking ?? player?.currentRank ?? null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** 强者现排名对应的最小现差要求 */
function requiredMinGap(strongRank) {
  const r = Number(strongRank);
  if (!Number.isFinite(r) || r <= 0) return Infinity;
  if (r <= 10) return 10;
  if (r <= 20) return 20;
  if (r <= 50) return 50;
  if (r <= 100) return 100;
  return Infinity;
}

function matchMetrics(m, rankingsByPlayer = {}) {
  const home = m?.homePlayer || { name: m?.home, ranking: null };
  const away = m?.awayPlayer || { name: m?.away, ranking: null };
  const homeR = currentRankOf(home, rankingsByPlayer);
  const awayR = currentRankOf(away, rankingsByPlayer);
  if (homeR == null || awayR == null) {
    return { gap: -1, strongRank: null, homeR, awayR, ready: false, minGap: Infinity };
  }
  const gap = Math.abs(homeR - awayR);
  const strongRank = Math.min(homeR, awayR);
  return {
    gap,
    strongRank,
    homeR,
    awayR,
    ready: true,
    minGap: requiredMinGap(strongRank),
  };
}

function passesTop100Pool(m, rankingsByPlayer = {}) {
  const home = m?.homePlayer || { name: m?.home, ranking: null };
  const away = m?.awayPlayer || { name: m?.away, ranking: null };
  const homeR = currentRankOf(home, rankingsByPlayer);
  const awayR = currentRankOf(away, rankingsByPlayer);
  return (
    (homeR != null && homeR <= TOP_RANK_MAX)
    || (awayR != null && awayR <= TOP_RANK_MAX)
  );
}

/** 任一方在 Top N 内（N=10/20/50/100） */
function passesTopPool(m, maxRank, rankingsByPlayer = {}) {
  const n = Number(maxRank);
  if (!Number.isFinite(n) || n <= 0) return false;
  const home = m?.homePlayer || { name: m?.home, ranking: null };
  const away = m?.awayPlayer || { name: m?.away, ranking: null };
  const homeR = currentRankOf(home, rankingsByPlayer);
  const awayR = currentRankOf(away, rankingsByPlayer);
  return (homeR != null && homeR <= n) || (awayR != null && awayR <= n);
}

/** 任一方 Top100；双方有排名时再按区间现差规则过滤 */
function passesRangeTennis(m, rankingsByPlayer = {}) {
  if (!passesTop100Pool(m, rankingsByPlayer)) return false;
  const metrics = matchMetrics(m, rankingsByPlayer);
  if (!metrics.ready) return true;
  return metrics.gap >= metrics.minGap;
}

function tierLabel(strongRank) {
  const r = Number(strongRank);
  if (!Number.isFinite(r)) return '—';
  if (r <= 10) return 'Top10 · 现差≥10';
  if (r <= 20) return 'Top20 · 现差≥20';
  if (r <= 50) return 'Top50 · 现差≥50';
  if (r <= 100) return 'Top100 · 现差≥100';
  return '—';
}

function allEventsFromBundle(bundle) {
  if (!bundle) return [];
  const tournaments = bundle.scheduled?.tournaments || [];
  const fromSched = tournaments.flatMap((t) =>
    (t.events || []).map((e) => ({
      ...e,
      tournament: e.tournament || t.name,
      tournamentShort: e.tournamentShort || t.name,
      level: e.level || t.level,
    })),
  );
  const live = (bundle.live?.matches || []).map((e) => ({ ...e }));
  const byId = new Map();
  for (const m of fromSched) {
    if (m?.id != null) byId.set(String(m.id), m);
  }
  for (const m of live) {
    if (m?.id == null) continue;
    const id = String(m.id);
    const prev = byId.get(id);
    byId.set(id, prev ? { ...prev, ...m } : m);
  }
  return [...byId.values()];
}

function groupEventsByTournament(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.tournament || e.tournamentShort || 'Other';
    if (!map.has(key)) {
      map.set(key, {
        name: key,
        level: e.level,
        tour: e.tour,
        events: [],
      });
    }
    map.get(key).events.push(e);
  }
  const tournaments = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    tournaments,
    tournamentCount: tournaments.length,
    eventCount: events.length,
  };
}

/** 从全量包中筛出区间网球场次并重组 scheduled/live */
function buildRangeBundle(sourceBundle, { requirePoly = false } = {}) {
  if (!sourceBundle) return null;
  const rankingsByPlayer = sourceBundle.rankingsByPlayer || {};
  const polyMap = sourceBundle.polymarketByEvent || {};
  const all = allEventsFromBundle(sourceBundle);
  const filtered = all.filter((m) => {
    if (!passesRangeTennis(m, rankingsByPlayer)) return false;
    if (requirePoly) {
      const poly = polyMap[m.id] || polyMap[String(m.id)];
      if (!poly?.url) return false;
    }
    return true;
  });

  const liveMatches = filtered.filter((m) => {
    const st = String(m.status || '').toLowerCase();
    const stType = String(m.statusType || '').toLowerCase();
    if (st === 'ended' || st === 'finished' || stType === 'finished') return false;
    return (
      st.includes('live')
      || st === 'inprogress'
      || st === 'started'
      || st.includes('1st')
      || st.includes('2nd')
      || st.includes('set')
    );
  });

  const scheduled = groupEventsByTournament(filtered);

  return {
    ...sourceBundle,
    sport: 'tennis',
    filter: 'range-top100',
    top_rank_max: TOP_RANK_MAX,
    rangeRules: {
      top10: 10,
      top20: 20,
      top50: 50,
      top100: 100,
    },
    scheduled,
    live: {
      tournaments: [],
      tournamentCount: 0,
      eventCount: liveMatches.length,
      matches: liveMatches,
    },
    events: filtered.length,
    message: `range-top100 · ${filtered.length} events`,
    source: sourceBundle.source || 'sofascore-monitor',
  };
}

/** 新网球列表：Top100 池全量（前端按 Top10/20/50/100 筛选） */
function buildNewBundle(sourceBundle) {
  if (!sourceBundle) return null;
  const rankingsByPlayer = sourceBundle.rankingsByPlayer || {};
  const polyMap = sourceBundle.polymarketByEvent || {};
  const filtered = allEventsFromBundle(sourceBundle).filter((m) =>
    passesTop100Pool(m, rankingsByPlayer),
  );

  const liveMatches = filtered.filter((m) => {
    const st = String(m.status || '').toLowerCase();
    const stType = String(m.statusType || '').toLowerCase();
    if (st === 'ended' || st === 'finished' || stType === 'finished') return false;
    return (
      st.includes('live')
      || st === 'inprogress'
      || st === 'started'
      || st.includes('1st')
      || st.includes('2nd')
      || st.includes('set')
    );
  });

  const scheduled = groupEventsByTournament(filtered);
  const filteredPoly = {};
  for (const m of filtered) {
    if (m?.id == null) continue;
    const key = String(m.id);
    const poly = polyMap[m.id] || polyMap[key];
    if (poly) filteredPoly[key] = poly;
  }

  return {
    ...sourceBundle,
    sport: 'tennis',
    filter: 'tennis-new',
    top_rank_max: TOP_RANK_MAX,
    top100: sourceBundle.top100 || {},
    poolRules: { top20: 20, top50: 50, top100: 100 },
    scheduled,
    live: {
      tournaments: [],
      tournamentCount: 0,
      eventCount: liveMatches.length,
      matches: liveMatches,
    },
    polymarketByEvent: filteredPoly,
    events: filtered.length,
    message: `tennis-new · ${filtered.length} events`,
    source: sourceBundle.source || 'sofascore-monitor',
  };
}

module.exports = {
  TOP_RANK_MAX,
  currentRankOf,
  requiredMinGap,
  matchMetrics,
  passesTop100Pool,
  passesTopPool,
  passesRangeTennis,
  tierLabel,
  allEventsFromBundle,
  buildRangeBundle,
  buildNewBundle,
  groupEventsByTournament,
};
