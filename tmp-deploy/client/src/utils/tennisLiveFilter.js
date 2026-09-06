/** ATP · WTA 盘中：任一方 Top100 + 强者分档最小现差（现差须大于阈值） */

export const TOP_RANK_MAX = 100

export function currentRankOf(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null
  const raw = fromMap?.current ?? player?.ranking ?? player?.currentRank ?? null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export function maxAllowedGap(strongRank) {
  const r = Number(strongRank)
  if (!Number.isFinite(r) || r <= 0) return 0
  if (r <= 10) return 20
  if (r <= 20) return 30
  if (r <= 50) return 50
  if (r <= 100) return 150
  return 0
}

export function matchLiveMetrics(m, rankingsByPlayer = {}) {
  const home = m?.homePlayer || { name: m?.home, ranking: null }
  const away = m?.awayPlayer || { name: m?.away, ranking: null }
  const homeR = currentRankOf(home, rankingsByPlayer)
  const awayR = currentRankOf(away, rankingsByPlayer)
  if (homeR == null || awayR == null) {
    return { gap: -1, strongRank: null, homeR, awayR, ready: false, maxGap: 0 }
  }
  const gap = Math.abs(homeR - awayR)
  const strongRank = Math.min(homeR, awayR)
  return {
    gap,
    strongRank,
    homeR,
    awayR,
    ready: true,
    maxGap: maxAllowedGap(strongRank),
  }
}

export function passesTop100Pool(m, rankingsByPlayer = {}) {
  const homeR = currentRankOf(m?.homePlayer || { name: m?.home }, rankingsByPlayer)
  const awayR = currentRankOf(m?.awayPlayer || { name: m?.away }, rankingsByPlayer)
  return (homeR != null && homeR <= TOP_RANK_MAX) || (awayR != null && awayR <= TOP_RANK_MAX)
}

export function passesLiveTop100(m, rankingsByPlayer = {}) {
  if (!passesTop100Pool(m, rankingsByPlayer)) return false
  const metrics = matchLiveMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return false
  return metrics.gap > metrics.maxGap
}

export function tierLabel(strongRank) {
  const r = Number(strongRank)
  if (!Number.isFinite(r)) return '—'
  if (r <= 10) return 'Top10+20'
  if (r <= 20) return 'Top20+30'
  if (r <= 50) return 'Top50+50'
  if (r <= 100) return 'Top100+150'
  return '—'
}

export const LIVE_TIER_OPTIONS = [
  { value: 'all', label: '全部档位' },
  { value: 't10', label: 'Top10+20' },
  { value: 't20', label: 'Top20+30' },
  { value: 't50', label: 'Top50+50' },
  { value: 't100', label: 'Top100+150' },
]

export function passesLiveTier(m, tier, rankingsByPlayer = {}) {
  if (!passesLiveTop100(m, rankingsByPlayer)) return false
  if (!tier || tier === 'all') return true
  const metrics = matchLiveMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return false
  const { strongRank, gap } = metrics
  if (tier === 't10') return strongRank <= 10 && gap > 20
  if (tier === 't20') return strongRank > 10 && strongRank <= 20 && gap > 30
  if (tier === 't50') return strongRank > 20 && strongRank <= 50 && gap > 50
  if (tier === 't100') return strongRank > 50 && strongRank <= 100 && gap > 150
  return true
}

export const LIVE_TIER_RULES = [
  { key: 't10', label: 'Top10', maxGap: 20, badge: 'Top10+20' },
  { key: 't20', label: 'Top20', maxGap: 30, badge: 'Top20+30' },
  { key: 't50', label: 'Top50', maxGap: 50, badge: 'Top50+50' },
  { key: 't100', label: 'Top100', maxGap: 150, badge: 'Top100+150' },
]

export const LIVE_RULES_TEXT = '任一方 Top100 · 进行中 · 强者分档现差：Top10>20 · Top20>30 · Top50>50 · Top100>150'
