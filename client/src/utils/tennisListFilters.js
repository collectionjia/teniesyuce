/**
 * 三产品列表条件过滤（文档 §四）
 * 现差 = 弱者现排 − 强者现排
 * 排差 = 现弱历史最高排名 − 现强历史最高排名
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
  const strongPlayer = homeStronger ? home : away
  const weakPlayer = homeStronger ? away : home
  const strongBest = bestRank(strongPlayer, rankingsByPlayer)
  const weakBest = bestRank(weakPlayer, rankingsByPlayer)
  const gap = weakRank - strongRank
  const rankDiff = (weakBest != null && strongBest != null) ? weakBest - strongBest : null
  return { ready: true, gap, rankDiff, strongRank, weakBest, strongBest, homeR, awayR }
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

/** 盘中自动买入条件；现差规则已移除，不再按现差过滤 */
export const DEFAULT_INPLAY_BETTING_ENTRY = {
  requireWonFirstSet: true,
  firstSetExcludeEnabled: true,
  firstSetExcludeScore: '7:5',
  pmCentsMax: 91,
  rankGapRules: [],
}

export function normalizeInplayBettingEntry(raw) {
  const d = DEFAULT_INPLAY_BETTING_ENTRY
  if (!raw || typeof raw !== 'object') {
    return {
      requireWonFirstSet: d.requireWonFirstSet,
      firstSetExcludeEnabled: d.firstSetExcludeEnabled,
      firstSetExcludeScore: d.firstSetExcludeScore,
      pmCentsMax: d.pmCentsMax,
      rankGapRules: [],
    }
  }
  let pmCentsMax = d.pmCentsMax
  if (raw.pmCentsMax === '' || raw.pmCentsMax === 'all' || raw.pmCentsMax == null) {
    pmCentsMax = 'all'
  } else if (Number.isFinite(Number(raw.pmCentsMax))) {
    pmCentsMax = Number(raw.pmCentsMax)
  }
  const excludeScore = raw.firstSetExcludeScore != null && String(raw.firstSetExcludeScore).trim()
    ? String(raw.firstSetExcludeScore).trim().slice(0, 12)
    : d.firstSetExcludeScore
  return {
    requireWonFirstSet: raw.requireWonFirstSet !== false,
    firstSetExcludeEnabled: raw.firstSetExcludeEnabled === true
      || (raw.firstSetExcludeEnabled == null && raw.requireWonFirstSet !== false && d.firstSetExcludeEnabled),
    firstSetExcludeScore: excludeScore || '7:5',
    pmCentsMax,
    rankGapRules: [],
  }
}

/** 解析「7:5」「7-5」→ { hi, lo }；无效返回 null */
export function parseGameScorePair(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const m = s.match(/^(\d+)\s*[:\-–／/]\s*(\d+)$/)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return { hi: Math.max(a, b), lo: Math.min(a, b) }
}

/** 首盘局分是否命中排除形（顺序无关）；games = { home, away } */
export function firstSetGamesMatchExclude(games, excludeRaw) {
  const pair = parseGameScorePair(excludeRaw)
  if (!pair || !games) return false
  const h = Number(games.home)
  const a = Number(games.away)
  if (!Number.isFinite(h) || !Number.isFinite(a)) return false
  return Math.max(h, a) === pair.hi && Math.min(h, a) === pair.lo
}

/**
 * 盘中自动买入：投注引擎 buckets.inplay.entry
 * opts.strongWonFirstSet(m)、opts.strongPolyCents(m)、opts.getFirstSetGames(m) 由调用方注入
 */
export function passesInplayBettingEntry(m, rankingsByPlayer = {}, entry, opts = {}) {
  const e = normalizeInplayBettingEntry(entry)
  const metrics = rankMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return false
  if (e.requireWonFirstSet) {
    if (typeof opts.strongWonFirstSet === 'function') {
      if (!opts.strongWonFirstSet(m)) return false
    }
    if (e.firstSetExcludeEnabled && typeof opts.getFirstSetGames === 'function') {
      const games = opts.getFirstSetGames(m)
      if (firstSetGamesMatchExclude(games, e.firstSetExcludeScore || '7:5')) return false
    }
  }
  if (e.pmCentsMax != null && e.pmCentsMax !== '' && e.pmCentsMax !== 'all') {
    const cents = typeof opts.strongPolyCents === 'function' ? opts.strongPolyCents(m) : null
    // 未设置/无赔率时不计算 PM 因素
    if (cents != null && !(Number(cents) < Number(e.pmCentsMax))) return false
  }
  return true
}

function isLimited(v) {
  return v != null && v !== '' && v !== 'all'
}

function scoreSide(m, side) {
  return side === 'home'
    ? (m.homeScore || m.home_score || m.score?.home || {})
    : (m.awayScore || m.away_score || m.score?.away || {})
}

function periodScore(block, i) {
  if (block == null || typeof block !== 'object') return null
  const n = Number(
    block[`period${i}`]
    ?? block[`set${i}`]
    ?? (Array.isArray(block.periods) ? block.periods[i - 1] : null),
  )
  return Number.isFinite(n) ? n : null
}

function isSetComplete(a, b) {
  if (a == null || b == null) return false
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  if (hi >= 6 && hi - lo >= 2) return true
  if (hi >= 7 && lo >= 5) return true
  return false
}

function pickStrongSide(m, rankingsByPlayer = {}) {
  const metrics = rankMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return null
  const home = m?.homePlayer || { name: m?.home }
  const away = m?.awayPlayer || { name: m?.away }
  const homeR = currentRank(home, rankingsByPlayer)
  const awayR = currentRank(away, rankingsByPlayer)
  if (homeR == null || awayR == null) return null
  return homeR < awayR ? 'home' : 'away'
}

function strongWonFirstSet(m, side) {
  const hs = scoreSide(m, 'home')
  const as = scoreSide(m, 'away')
  const h1 = periodScore(hs, 1)
  const a1 = periodScore(as, 1)
  if (h1 == null || a1 == null || h1 === a1) return false
  if (!isSetComplete(h1, a1)) return false
  const homeWon = h1 > a1
  return side === 'home' ? homeWon : !homeWon
}

function firstSetMatchesExcludeScore(m, excludeRaw) {
  const pair = parseGameScorePair(excludeRaw)
  if (!pair) return false
  const hs = scoreSide(m, 'home')
  const as = scoreSide(m, 'away')
  const h1 = periodScore(hs, 1)
  const a1 = periodScore(as, 1)
  if (h1 == null || a1 == null) return false
  return Math.max(h1, a1) === pair.hi && Math.min(h1, a1) === pair.lo
}

/** 单组：字段全部 AND（与服务端 tennisConditionApply.passGroup 一致） */
export function passConditionGroup(m, group, ctx = {}) {
  const rules = group || {}
  const rankings = ctx.rankingsByPlayer || {}
  const poly = ctx.polymarketByEvent || {}
  if (!passTour(m, rules.tour)) return false
  if (!passPm(m, rules.pm, poly)) return false
  const metrics = rankMetrics(m, rankings)
  if (isLimited(rules.strongRankMax)) {
    if (!metrics.ready || metrics.strongRank > Number(rules.strongRankMax)) return false
  }
  if (isLimited(rules.strongRankGt)) {
    if (!metrics.ready || !(metrics.strongRank > Number(rules.strongRankGt))) return false
  }
  if (isLimited(rules.strongRankLt)) {
    if (!metrics.ready || !(metrics.strongRank < Number(rules.strongRankLt))) return false
  }
  if (isLimited(rules.gapMin)) {
    if (!metrics.ready || metrics.gap < Number(rules.gapMin)) return false
  }
  if (isLimited(rules.rankDiffMin)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff < Number(rules.rankDiffMin)) return false
  }
  if (isLimited(rules.rankDiffMax)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff > Number(rules.rankDiffMax)) return false
  }
  if (rules.gapMode === 'tier') {
    if (!metrics.ready || metrics.gap < requiredTierGap(metrics.strongRank)) return false
  }
  if (rules.requireWonFirstSet) {
    const side = pickStrongSide(m, rankings)
    if (!side || !strongWonFirstSet(m, side)) return false
    if (rules.firstSetExcludeEnabled) {
      const excludeRaw = rules.firstSetExcludeScore != null
        ? String(rules.firstSetExcludeScore).trim()
        : '7:5'
      if (excludeRaw && firstSetMatchesExcludeScore(m, excludeRaw || '7:5')) return false
    }
  }
  return true
}

function evalGroupsChain(groups, passFn) {
  const list = Array.isArray(groups) ? groups : []
  if (!list.length) return false
  let ok = !!passFn(list[0], 0)
  for (let i = 1; i < list.length; i++) {
    const join = String(list[i]?.joinPrev || 'or').toLowerCase() === 'and' ? 'and' : 'or'
    const p = !!passFn(list[i], i)
    ok = join === 'and' ? (ok && p) : (ok || p)
  }
  return ok
}

/** 采集数据按投注条件组筛选；无组则原样返回 */
export function filterMatchesByConditionGroups(matches, groups, ctx = {}) {
  const list = Array.isArray(matches) ? matches : []
  const gs = Array.isArray(groups) ? groups : []
  if (!gs.length) return list
  return list.filter((m) => evalGroupsChain(gs, (g) => passConditionGroup(m, g, ctx)))
}

/** §九 现差默认： (现≤10且现差>20) 或 (现≤25且现差>30) */
export function passesInplayEntryRules(m, rankingsByPlayer = {}) {
  const metrics = rankMetrics(m, rankingsByPlayer)
  if (!metrics.ready) return false
  const { strongRank, gap } = metrics
  if (strongRank <= 10 && gap > 20) return true
  if (strongRank <= 25 && gap > 30) return true
  return false
}
