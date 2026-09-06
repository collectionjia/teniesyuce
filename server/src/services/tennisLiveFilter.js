/** 任一方 Top100 + 强者分档最小现差（现差须大于阈值） */

const { currentRankOf, passesTop100Pool, allEventsFromBundle, groupEventsByTournament } = require('./tennisRangeFilter');

const TOP_RANK_MAX = 100;

function maxAllowedGap(strongRank) {
  const r = Number(strongRank);
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (r <= 10) return 20;
  if (r <= 20) return 30;
  if (r <= 50) return 50;
  if (r <= 100) return 150;
  return 0;
}

function matchLiveMetrics(m, rankingsByPlayer = {}) {
  const home = m?.homePlayer || { name: m?.home, ranking: null };
  const away = m?.awayPlayer || { name: m?.away, ranking: null };
  const homeR = currentRankOf(home, rankingsByPlayer);
  const awayR = currentRankOf(away, rankingsByPlayer);
  if (homeR == null || awayR == null) {
    return { gap: -1, strongRank: null, homeR, awayR, ready: false, maxGap: 0 };
  }
  const gap = Math.abs(homeR - awayR);
  const strongRank = Math.min(homeR, awayR);
  return {
    gap,
    strongRank,
    homeR,
    awayR,
    ready: true,
    maxGap: maxAllowedGap(strongRank),
  };
}

function isLiveMatch(m) {
  const st = String(m?.status || '').toLowerCase();
  const stType = String(m?.statusType || '').toLowerCase();
  if (st === 'ended' || st === 'finished' || stType === 'finished') return false;
  return (
    st.includes('live')
    || st === 'inprogress'
    || st === 'started'
    || st.includes('1st')
    || st.includes('2nd')
    || st.includes('3rd')
    || st.includes('set')
    || st.includes('进行')
    || st.includes('interrupt')
  );
}

/** 任一方 Top100；双方有排名且现差大于分档阈值 */
function passesLiveTop100(m, rankingsByPlayer = {}) {
  if (!passesTop100Pool(m, rankingsByPlayer)) return false;
  const metrics = matchLiveMetrics(m, rankingsByPlayer);
  if (!metrics.ready) return false;
  return metrics.gap > metrics.maxGap;
}

function tierLabel(strongRank) {
  const r = Number(strongRank);
  if (!Number.isFinite(r)) return '—';
  if (r <= 10) return 'Top10+20';
  if (r <= 20) return 'Top20+30';
  if (r <= 50) return 'Top50+50';
  if (r <= 100) return 'Top100+150';
  return '—';
}

/** 列表分档筛选：all | t10 | t20 | t50 | t100 */
function passesLiveTier(m, tier, rankingsByPlayer = {}) {
  if (!passesLiveTop100(m, rankingsByPlayer)) return false;
  if (!tier || tier === 'all') return true;
  const metrics = matchLiveMetrics(m, rankingsByPlayer);
  if (!metrics.ready) return false;
  const { strongRank, gap } = metrics;
  if (tier === 't10') return strongRank <= 10 && gap > 20;
  if (tier === 't20') return strongRank > 10 && strongRank <= 20 && gap > 30;
  if (tier === 't50') return strongRank > 20 && strongRank <= 50 && gap > 50;
  if (tier === 't100') return strongRank > 50 && strongRank <= 100 && gap > 150;
  return true;
}

function isEndedMatch(m) {
  const st = String(m?.status || '').toLowerCase();
  const stType = String(m?.statusType || '').toLowerCase();
  return st === 'ended' || st === 'finished' || stType === 'finished' || st.includes('结束');
}

function buildLiveBundle(sourceBundle, { requirePoly = false } = {}) {
  if (!sourceBundle) return null;
  const rankingsByPlayer = sourceBundle.rankingsByPlayer || {};
  const polyMap = sourceBundle.polymarketByEvent || {};
  const all = allEventsFromBundle(sourceBundle);
  const passes = (m) => {
    if (!passesTop100Pool(m, rankingsByPlayer)) return false;
    if (requirePoly) {
      const poly = polyMap[m.id] || polyMap[String(m.id)];
      if (!poly?.url) return false;
    }
    return true;
  };
  const liveFiltered = all.filter((m) => isLiveMatch(m) && passes(m));
  const schedFiltered = all.filter((m) => !isLiveMatch(m) && !isEndedMatch(m) && passes(m));
  const scheduled = groupEventsByTournament(schedFiltered);

  return {
    ...sourceBundle,
    sport: 'tennis',
    filter: 'live-top100',
    top_rank_max: TOP_RANK_MAX,
    scheduled: {
      tournaments: scheduled.tournaments || [],
      tournamentCount: scheduled.tournamentCount || 0,
      eventCount: schedFiltered.length,
    },
    live: {
      tournaments: groupEventsByTournament(liveFiltered).tournaments || [],
      tournamentCount: groupEventsByTournament(liveFiltered).tournamentCount || 0,
      eventCount: liveFiltered.length,
      matches: liveFiltered,
    },
    events: liveFiltered.length + schedFiltered.length,
    message: `live-top100 · ${liveFiltered.length} 进行中 · ${schedFiltered.length} 赛程`,
    source: sourceBundle.source || 'sofascore-monitor',
  };
}

module.exports = {
  TOP_RANK_MAX,
  maxAllowedGap,
  matchLiveMetrics,
  isLiveMatch,
  passesLiveTop100,
  passesLiveTier,
  tierLabel,
  buildLiveBundle,
  allEventsFromBundle,
  groupEventsByTournament,
};
