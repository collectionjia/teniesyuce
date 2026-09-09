/**
 * 三产品列表条件过滤（文档 §四）
 * 现差 = 弱者现排 − 强者现排
 * 排差 = 强者现排 − 弱者历史最高排名
 */

export const FILTER_KEYS = {
  prematch: 'yuce.tennis.prematch.filters.v1',
  inplay: 'yuce.tennis.inplay.filters.v1',
  settled: 'yuce.tennis.settled.filters.v1',
}

export const DEFAULT_FILTERS = {
  prematch: {
    tour: 'all',
    pm: 'all',
    gapMin: '50',
    rankDiffMax: '0',
    strongRankMax: '20',
  },
  inplay: {
    tour: 'all',
    pm: 'all',
    strongRankMax: '100',
    gapMode: 'all', // all | tier
  },
  settled: {
    tour: 'all',
    pm: 'all',
    strongRankMax: '100',
    pnlMark: 'all', // all | bet | win | loss
  },
}

export function loadFilters(product) {
  const key = FILTER_KEYS[product]
  const defaults = { ...DEFAULT_FILTERS[product] }
  if (!key) return defaults
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null')
    if (!raw || typeof raw !== 'object') return defaults
    return { ...defaults, ...raw }
  } catch {
    return defaults
  }
}

export function saveFilters(product, filters) {
  const key = FILTER_KEYS[product]
  if (!key) return
  localStorage.setItem(key, JSON.stringify(filters))
}

function currentRank(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null
  const n = Number(fromMap?.current ?? player?.ranking ?? player?.currentRank ?? player?.rank)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function bestRank(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null
  const n = Number(fromMap?.best ?? player?.bestRank ?? player?.best)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** 现差、排差、强现（文档口径） */
export function rankMetrics(m, rankingsByPlayer = {}) {
  const home = m?.homePlayer || { name: m?.home }
  const away = m?.awayPlayer || { name: m?.away }
  const homeR = currentRank(home, rankingsByPlayer)
  const awayR = currentRank(away, rankingsByPlayer)
  if (homeR == null || awayR == null) {
    return { ready: false, gap: null, rankDiff: null, strongRank: null, weakBest: null }
  }
  const homeStronger = homeR < awayR
  const strongRank = homeStronger ? homeR : awayR
  const weakRank = homeStronger ? awayR : homeR
  const weakPlayer = homeStronger ? away : home
  const weakBest = bestRank(weakPlayer, rankingsByPlayer)
  const gap = weakRank - strongRank
  const rankDiff = weakBest != null ? strongRank - weakBest : null
  return { ready: true, gap, rankDiff, strongRank, weakBest, homeR, awayR }
}

function requiredTierGap(strongRank) {
  const r = Number(strongRank)
  if (!Number.isFinite(r) || r <= 0) return Infinity
  if (r <= 10) return 20
  if (r <= 20) return 30
  if (r <= 50) return 50
  if (r <= 100) return 150
  return Infinity
}

function matchTour(m) {
  return (m.tour || ((m.gender || m.homePlayer?.gender || m.awayPlayer?.gender) === 'F' ? 'WTA' : 'ATP')).toUpperCase()
}

function hasPm(m, polymarketByEvent = {}) {
  const id = m?.id
  if (id == null) return false
  const p = polymarketByEvent[String(id)] || polymarketByEvent[id]
  return !!(p?.url || m?.polymarketUrl)
}

function passTour(m, tour) {
  if (!tour || tour === 'all') return true
  const t = matchTour(m)
  if (tour === 'ATP' || tour === '男') return t === 'ATP'
  if (tour === 'WTA' || tour === '女') return t === 'WTA'
  return t === String(tour).toUpperCase()
}

function passPm(m, pm, polymarketByEvent) {
  if (!pm || pm === 'all') return true
  const ok = hasPm(m, polymarketByEvent)
  return pm === 'yes' ? ok : !ok
}

export function applyPrematchFilters(matches, filters, ctx = {}) {
  const list = Array.isArray(matches) ? matches : []
  const f = { ...DEFAULT_FILTERS.prematch, ...filters }
  const rankings = ctx.rankingsByPlayer || {}
  const poly = ctx.polymarketByEvent || {}
  return list.filter((m) => {
    if (!passTour(m, f.tour)) return false
    if (!passPm(m, f.pm, poly)) return false
    const metrics = rankMetrics(m, rankings)
    if (f.strongRankMax !== 'all' && f.strongRankMax != null) {
      if (!metrics.ready || metrics.strongRank > Number(f.strongRankMax)) return false
    }
    if (f.gapMin !== 'all' && f.gapMin != null) {
      if (!metrics.ready || metrics.gap < Number(f.gapMin)) return false
    }
    if (f.rankDiffMax !== 'all' && f.rankDiffMax != null) {
      if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff > Number(f.rankDiffMax)) return false
    }
    return true
  })
}

export function applyInplayFilters(matches, filters, ctx = {}) {
  const list = Array.isArray(matches) ? matches : []
  const f = { ...DEFAULT_FILTERS.inplay, ...filters }
  const rankings = ctx.rankingsByPlayer || {}
  const poly = ctx.polymarketByEvent || {}
  return list.filter((m) => {
    if (!passTour(m, f.tour)) return false
    if (!passPm(m, f.pm, poly)) return false
    const metrics = rankMetrics(m, rankings)
    if (f.strongRankMax !== 'all' && f.strongRankMax != null) {
      if (!metrics.ready || metrics.strongRank > Number(f.strongRankMax)) return false
    }
    if (f.gapMode === 'tier') {
      if (!metrics.ready) return false
      if (metrics.gap < requiredTierGap(metrics.strongRank)) return false
    }
    return true
  })
}

export function applySettledFilters(matches, filters, ctx = {}) {
  const list = Array.isArray(matches) ? matches : []
  const f = { ...DEFAULT_FILTERS.settled, ...filters }
  const rankings = ctx.rankingsByPlayer || {}
  const poly = ctx.polymarketByEvent || {}
  const pnlByEvent = ctx.pnlByEvent || {}
  const betEventIds = ctx.betEventIds || {}
  return list.filter((m) => {
    if (!passTour(m, f.tour)) return false
    if (!passPm(m, f.pm, poly)) return false
    const metrics = rankMetrics(m, rankings)
    if (f.strongRankMax !== 'all' && f.strongRankMax != null) {
      if (!metrics.ready || metrics.strongRank > Number(f.strongRankMax)) return false
    }
    if (f.pnlMark && f.pnlMark !== 'all') {
      const id = String(m.id)
      const mark = pnlByEvent[id]
      const hasBet = betEventIds[id] === true || mark != null
      if (f.pnlMark === 'bet' && !hasBet) return false
      if (f.pnlMark === 'win' && !(mark > 0)) return false
      if (f.pnlMark === 'loss' && !(mark < 0)) return false
    }
    return true
  })
}

/** §九 买入： (现≤10且现差>20) 或 (现≤25且现差>30) */
export function passesInplayEntryRules(m, rankingsByPlayer = {}) {
  const metrics = rankMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return false
  const { strongRank, gap } = metrics
  if (strongRank <= 10 && gap > 20) return true
  if (strongRank <= 25 && gap > 30) return true
  return false
}
