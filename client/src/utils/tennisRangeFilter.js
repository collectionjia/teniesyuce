/** 区间网球筛选：双方 Top100 + 分档现差 */

export const TOP_RANK_MAX = 100

export function currentRankOf(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null
  const raw = fromMap?.current ?? player?.ranking ?? player?.currentRank ?? null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export function requiredMinGap(strongRank) {
  const r = Number(strongRank)
  if (!Number.isFinite(r) || r <= 0) return Infinity
  if (r <= 10) return 10
  if (r <= 20) return 20
  if (r <= 50) return 50
  if (r <= 100) return 100
  return Infinity
}

export function matchRangeMetrics(m, rankingsByPlayer = {}) {
  const home = m?.homePlayer || { name: m?.home, ranking: null }
  const away = m?.awayPlayer || { name: m?.away, ranking: null }
  const homeR = currentRankOf(home, rankingsByPlayer)
  const awayR = currentRankOf(away, rankingsByPlayer)
  if (homeR == null || awayR == null) {
    return { gap: -1, strongRank: null, ready: false, minGap: Infinity }
  }
  const gap = Math.abs(homeR - awayR)
  const strongRank = Math.min(homeR, awayR)
  return {
    gap,
    strongRank,
    homeR,
    awayR,
    ready: true,
    minGap: requiredMinGap(strongRank),
  }
}

export function passesRangeTennis(m, rankingsByPlayer = {}) {
  const metrics = matchRangeMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return false
  if (metrics.homeR > TOP_RANK_MAX || metrics.awayR > TOP_RANK_MAX) return false
  return metrics.gap >= metrics.minGap
}

export function tierLabel(strongRank) {
  const r = Number(strongRank)
  if (!Number.isFinite(r)) return '—'
  if (r <= 10) return 'Top10·≥10'
  if (r <= 20) return 'Top20·≥20'
  if (r <= 50) return 'Top50·≥50'
  if (r <= 100) return 'Top100·≥100'
  return '—'
}

export const RANGE_RULES_TEXT = '双方 Top100 · Top10差≥10 / Top20差≥20 / Top50差≥50 / Top100差≥100'
