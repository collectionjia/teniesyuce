/** 区间网球筛选：任一方 Top100 + 分档现差 */

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
    return { gap: -1, strongRank: null, homeR, awayR, ready: false, minGap: Infinity }
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

export function passesTop100Pool(m, rankingsByPlayer = {}) {
  const homeR = currentRankOf(m?.homePlayer || { name: m?.home }, rankingsByPlayer)
  const awayR = currentRankOf(m?.awayPlayer || { name: m?.away }, rankingsByPlayer)
  return (homeR != null && homeR <= TOP_RANK_MAX) || (awayR != null && awayR <= TOP_RANK_MAX)
}

export function passesTopPool(m, maxRank, rankingsByPlayer = {}) {
  const n = Number(maxRank)
  if (!Number.isFinite(n) || n <= 0) return false
  const homeR = currentRankOf(m?.homePlayer || { name: m?.home }, rankingsByPlayer)
  const awayR = currentRankOf(m?.awayPlayer || { name: m?.away }, rankingsByPlayer)
  return (homeR != null && homeR <= n) || (awayR != null && awayR <= n)
}

export function passesRangeTennis(m, rankingsByPlayer = {}) {
  if (!passesTop100Pool(m, rankingsByPlayer)) return false
  const metrics = matchRangeMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return true
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

export const RANGE_RULES_TEXT = '任一方 Top100 · Top10差≥10 / Top20差≥20 / Top50差≥50 / Top100差≥100'
export const NEW_POOL_RULES_TEXT = '排名前50运动员赛事 · 任一方现排名在 Top N 内 · 可选 Top20 / Top50'
