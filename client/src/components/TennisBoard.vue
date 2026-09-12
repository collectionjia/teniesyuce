<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as api from '../api'
import { passesRangeTennis, passesTopPool, matchRangeMetrics, tierLabel, RANGE_RULES_TEXT, NEW_POOL_RULES_TEXT, matchInplayRankMetrics, inplayTierLabel } from '../utils/tennisRangeFilter'
import {
  loadFilters,
  saveFilters,
  applyPrematchFilters,
  applyInplayFilters,
  applySettledFilters,
  passesInplayEntryRules,
} from '../utils/tennisListFilters'

const INPLAY_AUTO_RULES_TEXT = '买入：(现≤10且现差>20)或(现≤25且现差>30)·赢首盘·PM<91¢｜止损：局差弱−强>2（BO3第三盘；BO5 路径见§九）'
const props = defineProps({
  showFilters: { type: Boolean, default: false },
  /** 有效订阅内可见排名/推荐/详情/外链 */
  isMember: { type: Boolean, default: false },
  /** 已配置钱包且开通 BTC 虚拟投注时可批量下单 */
  canBatchTrade: { type: Boolean, default: false },
  /** classic | range | live | new | inplay | prematch | settled */
  boardMode: { type: String, default: 'classic' },
})

const isRangeMode = computed(() => props.boardMode === 'range')
const isLiveMode = computed(() => props.boardMode === 'live')
const isNewMode = computed(() => props.boardMode === 'new')
const isInplayMode = computed(() => props.boardMode === 'inplay')
const isPrematchMode = computed(() => props.boardMode === 'prematch')
const isSettledMode = computed(() => props.boardMode === 'settled')
const isClassicMode = computed(() =>
  !isRangeMode.value
  && !isLiveMode.value
  && !isNewMode.value
  && !isInplayMode.value
  && !isPrematchMode.value
  && !isSettledMode.value
)
/** 经典网球：现差/排差/强现 筛选（订阅、管理员、或已开通筛选权限） */
const classicRankFiltersOn = computed(() => isClassicMode.value && (props.isMember || props.showFilters))
/** 网球 / 网球自投：列表不展示已结束场次；盘中采集仅进行中；盘后展示已结束 */
const hideEndedEvents = computed(() => {
  if (data.value?.upstream === 'docks500' || data.value?.source === 'docks500' || data.value?.dataSource === 'docks500') {
    return false
  }
  return isClassicMode.value || isInplayMode.value || isPrematchMode.value
})
const allowBatchTrade = computed(() => !isSettledMode.value && props.canBatchTrade)
const apiPath = computed(() => {
  if (isPrematchMode.value) return '/api/tennis-prematch'
  if (isRangeMode.value) return '/api/tennis-range'
  if (isLiveMode.value) return '/api/tennis-live'
  if (isNewMode.value) return '/api/tennis-new'
  if (isInplayMode.value) return '/api/tennis-inplay'
  if (isSettledMode.value) return '/api/tennis-settled'
  return '/api/tennis'
})
const PAGE_SIZE = 5
const data = ref(null)
const loading = ref(true)
const error = ref('')
const filter = ref('Not started') // all | Not started | liveish | ended
const tour = ref('all') // all | ATP | WTA
const gapMin = ref('50') // all | 50 | 70 | 90 · 现排名差下限（弱−强，如 121−2=119）
const diffMax = ref('0') // all | 0 | -30 | -50 | -70 · 历史最高排名差上限
const strongRankMax = ref('20') // all | 10 | 20 | 50 | 100
const pmFilter = ref('all') // all | yes | no — 是否只看有 Polymarket 外链的场次
const topPoolMax = ref('50') // 20 | 50（新网球列表 · Top50 池内筛选）
/** 盘后：盈亏标记筛选 */
const settledPnlMark = ref('all') // all | bet | win | loss
const filtersOpen = ref(false)
const detailMatch = ref(null)
/** 详情页字段说明是否展开 */
const detailHelpOpen = ref(false)

const DETAIL_TIPS = [
  { k: '男/女', t: '巡回赛性别（ATP 男 / WTA 女）。' },
  { k: '级别', t: '赛事级别，如 GS（大满贯）、1000、500 等。' },
  { k: '报', t: '已匹配到博彩全场胜负报价。' },
  { k: '外', t: '已匹配到 Polymarket 外链市场。' },
  { k: '盘中档', t: '按强者现排名分档（展示用）；列表条件由产品管理挂载的条件组控制。' },
  { k: '优', t: '现排名更高（数字更小）的一侧，建议关注方向。' },
  { k: '现排名 #', t: '球员当前世界排名，数字越小越强。' },
  { k: '比分', t: '进行中比赛的盘分/局分。' },
  { k: '年龄', t: '姓名后括号为年龄（按 2026−出生年估算）。' },
  { k: '周', t: '约一周前的排名（previous）。' },
  { k: '高', t: '历史最高排名（best），数字越小表示峰值越强。' },
  { k: 'L', t: '实时排名（live ranking）。' },
  { k: 'U', t: 'UTR 评分参考。' },
  { k: '现排名差', t: '双方现排名之差（弱−强），衡量实力落差。' },
  { k: '历史最高排名差', t: '双方历史最高排名之差（高−低）。' },
  { k: 'Elo', t: 'Tennis Abstract 等来源的胜率/优势估计；edge 为相对报价的优势百分比。' },
  { k: '报价', t: '博彩全场胜负赔率（欧赔小数）。' },
  { k: '外链价', t: 'Polymarket 对应市场价格（美分/隐含概率）。' },
]
const selectedIds = ref(new Set())
const batchAmountUsd = ref('1')
const batchSubmitting = ref(false)
const batchNotice = ref('')
const batchError = ref('')
const AUTO_BET_KEY = computed(() => {
  if (isPrematchMode.value) return 'yuce.tennisPrematch.autoBet.v1'
  if (isRangeMode.value) return 'yuce.tennisRange.autoBet.v1'
  if (isLiveMode.value) return 'yuce.tennisLive.autoBet.v1'
  if (isNewMode.value) return 'yuce.tennisNew.autoBet.v1'
  if (isInplayMode.value) return 'yuce.tennisInplay.autoBet.v1'
  return 'yuce.tennis.autoBet.v1'
})
const AUTO_PLACED_KEY = computed(() => {
  if (isPrematchMode.value) return 'yuce.tennisPrematch.autoPlaced.v1'
  if (isRangeMode.value) return 'yuce.tennisRange.autoPlaced.v1'
  if (isLiveMode.value) return 'yuce.tennisLive.autoPlaced.v1'
  if (isNewMode.value) return 'yuce.tennisNew.autoPlaced.v1'
  if (isInplayMode.value) return 'yuce.tennisInplay.autoPlaced.v1'
  return 'yuce.tennis.autoPlaced.v1'
})
const AUTO_SOLD_KEY = computed(() => 'yuce.tennisInplay.autoSold.v1')
const autoBetEnabled = ref(false)
const autoPlacedIds = ref(new Set())
const autoSoldIds = ref(new Set())
const stopLossBusy = ref(false)
const settledStats = ref(null)
let inplayPollTimer = null

function pct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return `${(Number(v) * 100).toFixed(0)}%`
}
function num(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Number(v).toFixed(2)
}

function loadTennisAutoState() {
  try {
    autoBetEnabled.value = localStorage.getItem(AUTO_BET_KEY.value) === '1'
    const raw = JSON.parse(localStorage.getItem(AUTO_PLACED_KEY.value) || '[]')
    autoPlacedIds.value = new Set(Array.isArray(raw) ? raw.map(String) : [])
    if (isInplayMode.value) {
      const sold = JSON.parse(localStorage.getItem(AUTO_SOLD_KEY.value) || '[]')
      autoSoldIds.value = new Set(Array.isArray(sold) ? sold.map(String) : [])
    }
  } catch {
    autoBetEnabled.value = false
    autoPlacedIds.value = new Set()
    autoSoldIds.value = new Set()
  }
}

function saveTennisAutoState() {
  localStorage.setItem(AUTO_BET_KEY.value, autoBetEnabled.value ? '1' : '0')
  localStorage.setItem(AUTO_PLACED_KEY.value, JSON.stringify([...autoPlacedIds.value].slice(-200)))
  if (isInplayMode.value) {
    localStorage.setItem(AUTO_SOLD_KEY.value, JSON.stringify([...autoSoldIds.value].slice(-200)))
  }
}

async function toggleAutoBet(ev) {
  const want = !!ev?.target?.checked
  if (want && !allowBatchTrade.value) {
    batchError.value = '当前账号未开通网球自动投注'
    ev.target.checked = false
    return
  }
  if (want && !window.confirm(
    isInplayMode.value
      ? `确认开启盘中自动投注？\n规则：${INPLAY_AUTO_RULES_TEXT}\n买入后按止损条件自动平仓，风险自负。`
      : '确认开启网球自动投注？\n将对可同步场次按当前金额自动批量确认，风险自负。'
  )) {
    ev.target.checked = false
    return
  }
  autoBetEnabled.value = want
  saveTennisAutoState()
  batchNotice.value = want ? '已开启自动投注' : '已关闭自动投注'
  syncInplayPoll()
  if (want) {
    await maybeAutoBatchTrade()
    if (isInplayMode.value) await maybeAutoStopLoss()
  }
}
const serverTimeBase = ref(null)
const loadedAtMs = ref(null)
const clockTick = ref(0)
let tickTimer = null

/** 基于 API 返回的服务器时间推算当前秒级时间戳 */
const nowSec = computed(() => {
  clockTick.value
  if (serverTimeBase.value == null) return Math.floor(Date.now() / 1000)
  return serverTimeBase.value + Math.floor((Date.now() - (loadedAtMs.value || Date.now())) / 1000)
})

function isLiveStatus(s) {
  if (!s) return false
  const t = String(s).toLowerCase()
  return (
    t.includes('live') ||
    t === 'inprogress' ||
    t === 'started' ||
    t === 'interrupted' ||
    t.includes('1st') ||
    t.includes('2nd') ||
    t.includes('3rd') ||
    t.includes('set') ||
    t.includes('进行') ||
    t.includes('interrupt')
  )
}

function isEndedStatus(s) {
  if (!s) return false
  const t = String(s).toLowerCase()
  return t === 'ended' || t === 'finished' || t === 'closed' || t === 'walkover'
}

/** 开赛时间已到则视为进行中（与后端 serverTime 对齐）；仅对「未开赛」做超时兜底 */
function effectiveStatus(m) {
  if (!m) return ''
  const raw = m.status
  const rawType = m.statusType
  if (isEndedStatus(raw) || String(rawType).toLowerCase() === 'finished') return raw || 'Ended'
  // 源已标明进行中（含 1st/2nd set）→ 信任源数据，绝不用开赛时长强行改成结束（大满贯长盘会误伤比分）
  if (isLiveStatus(raw) || isLiveStatus(rawType)) return raw
  const ts = Number(m.startTimestamp)
  const age = Number.isFinite(ts) && ts > 0 ? nowSec.value - ts : null
  const notStarted =
    raw === 'Not started' || String(rawType || '').toLowerCase() === 'notstarted'
  if (notStarted && Number.isFinite(ts) && ts > 0 && nowSec.value >= ts) {
    if (age != null && age > 6 * 3600) return 'Ended'
    return 'Live'
  }
  return raw || ''
}

function isMatchEnded(m) {
  if (!m) return false
  const eff = effectiveStatus(m)
  if (isEndedStatus(eff)) return true
  const raw = m.status
  const rawType = m.statusType
  return isEndedStatus(raw) || isEndedStatus(rawType) || String(rawType || '').toLowerCase() === 'finished'
}

function isMatchLive(m) {
  if (isMatchEnded(m)) return false
  const s = effectiveStatus(m)
  return isLiveStatus(s) || isLiveStatus(m?.statusType)
}

function isMatchNotStarted(m) {
  return effectiveStatus(m) === 'Not started'
}

function rankText(v) {
  return v == null || v === '' ? '—' : String(v)
}

function shortName(name) {
  if (!name) return '—'
  const parts = String(name).trim().split(/\s+/)
  return parts.length <= 1 ? parts[0] : parts[parts.length - 1]
}

function rankDetailOf(player, match = null) {
  const id = player?.id ?? player?.teamId
  const map = data.value?.rankingsByPlayer || {}
  const fromMap = id != null ? map[String(id)] || map[id] : null
  const ev = match || detailMatch.value
  const fromEvent = id != null && ev?.rankings
    ? (ev.rankings[String(id)] || ev.rankings[id] || null)
    : null
  return {
    current: fromMap?.current ?? fromEvent?.current ?? player?.ranking ?? player?.currentRank ?? player?.rank ?? null,
    previous: fromMap?.previous ?? fromEvent?.previous ?? player?.previousRank ?? null,
    best: fromMap?.best ?? fromEvent?.best ?? player?.bestRank ?? player?.best ?? null,
    live: fromMap?.live ?? fromEvent?.live ?? player?.liveRank ?? null,
    utr: fromMap?.utr ?? fromEvent?.utr ?? player?.utr ?? null,
  }
}

function currentRankOf(player) {
  return rankDetailOf(player).current
}

function playerNameWithAge(player, eloSide) {
  const name = player?.name || '—'
  const year = 2026 // 年龄 = 2026 − 出生年
  const subs = player?.subTeams
  if (Array.isArray(subs) && subs.length) {
    const ages = subs.map((s) => {
      if (s?.birthYear != null && s.birthYear !== '') return year - Number(s.birthYear)
      if (s?.age != null && s.age !== '') return Math.floor(Number(s.age))
      return null
    })
    if (ages.every((a) => Number.isFinite(a) && a > 0)) return `${name} (${ages.join('/')})`
  }
  let age = null
  const pid = player?.id ?? player?.teamId
  const fromMap = pid != null
    ? (data.value?.birthYearByPlayer?.[String(pid)] ?? data.value?.birthYearByPlayer?.[pid])
    : null
  const birthYear = player?.birthYear ?? fromMap
  if (birthYear != null && birthYear !== '') age = year - Number(birthYear)
  else if (player?.age != null && player.age !== '') age = Math.floor(Number(player.age))
  else if (eloSide?.age != null && eloSide.age !== '') age = Math.floor(Number(eloSide.age))
  if (!Number.isFinite(age) || age <= 0) return `${name} (无)`
  return `${name} (${age})`
}

function matchMetrics(m) {
  const home = m.homePlayer || { name: m.home, ranking: null }
  const away = m.awayPlayer || { name: m.away, ranking: null }
  const homeR = currentRankOf(home)
  const awayR = currentRankOf(away)
  if (homeR == null || awayR == null) {
    return { gap: -1, rankDiff: 0, ready: false, hasRankDiff: false, strongRank: null }
  }
  // 现差 = 弱现−强现；排差 = 强者现排 − 弱者历史最高
  const gap = Math.max(homeR, awayR) - Math.min(homeR, awayR)
  const homeStronger = homeR < awayR
  const strongNow = homeStronger ? homeR : awayR
  const homeDetail = rankDetailOf(home)
  const awayDetail = rankDetailOf(away)
  const weakBest = homeStronger
    ? (awayDetail.best != null ? Number(awayDetail.best) : null)
    : (homeDetail.best != null ? Number(homeDetail.best) : null)
  const hasRankDiff = Number.isFinite(weakBest)
  const rankDiff = hasRankDiff ? strongNow - weakBest : 0
  return { gap, rankDiff, ready: true, hasRankDiff, strongRank: strongNow }
}

function matchPassesTour(m) {
  if (tour.value === 'all') return true
  const t = (m.tour || ((m.gender || m.homePlayer?.gender || m.awayPlayer?.gender) === 'F' ? 'WTA' : 'ATP')).toUpperCase()
  return t === tour.value
}

/** 排名/现差筛选（仅用于未开始、全部；无权限时不按排名筛） */
function matchPassesRank(m) {
  if (!matchPassesTour(m)) return false
  const rankFiltersOn = isRangeMode.value || isNewMode.value
    ? props.isMember
    : classicRankFiltersOn.value
  if (!rankFiltersOn) return true
  if (isRangeMode.value) {
    return passesRangeTennis(m, data.value?.rankingsByPlayer || {})
  }
  if (isNewMode.value) {
    return passesTopPool(m, topPoolMax.value, data.value?.rankingsByPlayer || {})
  }
  const metrics = matchMetrics(m)
  if (gapMin.value !== 'all') {
    // 现排名差 ≥ 阈值（弱−强）
    if (!metrics.ready || metrics.gap < Number(gapMin.value)) return false
  }
  if (diffMax.value !== 'all') {
    if (!metrics.ready || !metrics.hasRankDiff || metrics.rankDiff > Number(diffMax.value)) return false
  }
  if (strongRankMax.value !== 'all') {
    if (!metrics.ready || metrics.strongRank == null || metrics.strongRank > Number(strongRankMax.value)) return false
  }
  return true
}

const STATUS_TABS = new Set(['all', 'Not started', 'liveish', 'ended'])

function hasPmData(m) {
  return !!polyUrlOf(m)
}

function matchPassesPm(m) {
  if (pmFilter.value === 'yes') return hasPmData(m)
  if (pmFilter.value === 'no') return !hasPmData(m)
  return true
}

function matchPassesFilter(m, statusFilter) {
  const rankings = data.value?.rankingsByPlayer || {}
  const poly = data.value?.polymarketByEvent || {}
  // 盘前/盘中/盘后：排名类条件由产品挂载的条件组在服务端筛；列表仅保留巡回/PM（盘后另保留盈亏）
  if (isPrematchMode.value) {
    if (!isMatchNotStarted(m)) return false
    return applyPrematchFilters([m], {
      tour: tour.value,
      pm: pmFilter.value,
      gapMin: 'all',
      rankDiffMax: 'all',
      strongRankMax: 'all',
    }, { rankingsByPlayer: rankings, polymarketByEvent: poly }).length > 0
  }
  if (isInplayMode.value) {
    if (!isMatchLive(m)) return false
    return applyInplayFilters([m], {
      tour: tour.value,
      pm: pmFilter.value,
      strongRankMax: 'all',
      gapMode: 'all',
    }, { rankingsByPlayer: rankings, polymarketByEvent: poly }).length > 0
  }
  if (isSettledMode.value) {
    if (!isMatchEnded(m)) return false
    const stats = settledStats.value || {}
    return applySettledFilters([m], {
      tour: tour.value,
      pm: pmFilter.value,
      strongRankMax: 'all',
      pnlMark: settledPnlMark.value,
    }, {
      rankingsByPlayer: rankings,
      polymarketByEvent: poly,
      pnlByEvent: stats.pnlByEvent || {},
      betEventIds: stats.betEventIds || {},
    }).length > 0
  }
  if (hideEndedEvents.value && isMatchEnded(m)) return false
  const mode = STATUS_TABS.has(statusFilter) ? statusFilter : filter.value
  if (!matchPassesTour(m)) return false
  if (!matchPassesPm(m)) return false
  if (isMatchEnded(m) && mode === 'liveish') return false
  if (mode === 'liveish') {
    if (!isMatchLive(m)) return false
    return matchPassesRank(m)
  }
  if (mode === 'ended') {
    return isMatchEnded(m)
  }
  if (mode === 'Not started') {
    if (!isMatchNotStarted(m)) return false
    return matchPassesRank(m)
  }
  if (isMatchEnded(m)) return true
  return matchPassesRank(m)
}

function allMatches(bundle) {
  if (!bundle) return []
  if (isInplayMode.value) {
    return (bundle.live?.matches || []).map((e) => ({ ...e }))
  }
  const tournaments = bundle.scheduled?.tournaments || []
  const fromSched = tournaments.flatMap((t) =>
    (t.events || []).map((e) => ({
      ...e,
      tournament: e.tournament || t.name,
      tournamentShort: e.tournamentShort || t.name,
      level: e.level || t.level,
    }))
  )
  const live = (bundle.live?.matches || []).map((e) => ({ ...e }))
  const byId = new Map()
  for (const m of fromSched) {
    if (m?.id != null) byId.set(String(m.id), m)
  }
  for (const m of live) {
    if (m?.id == null) continue
    const id = String(m.id)
    const prev = byId.get(id)
    byId.set(id, prev ? { ...prev, ...m } : m)
  }
  return [...byId.values()]
}

function sortMatches(list) {
  return [...list].sort((a, b) => {
    const ta = a.startTimestamp || 0
    const tb = b.startTimestamp || 0
    if (ta !== tb) return ta - tb
    return (a.id || 0) - (b.id || 0)
  })
}

const rawMatches = computed(() => allMatches(data.value))
const matches = computed(() => sortMatches(rawMatches.value.filter((m) => matchPassesFilter(m))))
const currentPage = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(matches.value.length / PAGE_SIZE)))
const paginatedMatches = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return matches.value.slice(start, start + PAGE_SIZE)
})

function isInplayTier500Or1000(m) {
  const raw = String(m?.level || '').toLowerCase()
  const label = matchLevelLabel(m).toLowerCase()
  const pts = Number(m?.tennisPoints ?? m?.tournament?.tennisPoints)
  if (pts === 500 || pts === 1000) return true
  if (/\bgs\b/.test(label) || raw.includes('grand_slam') || raw.includes('grand slam')) return false
  if (/\b500\b/.test(label) || /\b1000\b/.test(label)) return true
  if (/\b500\b/.test(raw) || /\b1000\b/.test(raw) || raw.includes('masters')) return true
  return false
}

function polySidePrice(m, side) {
  const poly = polyOf(m?.id)
  if (!poly) return null
  let p = side === 'home' ? poly.home_price : poly.away_price
  if (p == null && Array.isArray(poly.moneyline?.prices)) {
    p = poly.moneyline.prices[side === 'home' ? 0 : 1]
  }
  if (p == null) return null
  const n = Number(p)
  if (!Number.isFinite(n)) return null
  return n <= 1 ? n : n / 100
}

function strongPolyPriceCents(m) {
  const side = pickSide(m)
  if (!side) return null
  const p = polySidePrice(m, side)
  if (p == null) return null
  return p * 100
}

function strongWonFirstSet(m) {
  const side = pickSide(m)
  if (!side) return false
  const pairs = liveSetPairs(m)
  if (!pairs.length) return false
  const first = pairs[0]
  if (first.home === first.away) return false
  return side === 'home' ? first.home > first.away : first.away > first.home
}

function isTennisSetComplete(a, b) {
  const x = Number(a)
  const y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  const hi = Math.max(x, y)
  const lo = Math.min(x, y)
  if (hi >= 7) return true
  if (hi >= 6 && hi - lo >= 2) return true
  return false
}

/** ATP 大满贯男单等 BO5；已打到第 4/5 盘也视为 BO5 */
function isBo5Match(m) {
  const pairs = liveSetPairs(m)
  if (pairs.length >= 4) return true
  const label = matchLevelLabel(m).toLowerCase()
  const raw = String(m?.level || '').toLowerCase()
  const isGs = /\bgs\b/.test(label) || raw.includes('grand_slam') || raw.includes('grand slam')
  if (!isGs) return false
  const tour = String(m.tour || '').toUpperCase()
  const gender = String(m.gender || m.homePlayer?.gender || m.awayPlayer?.gender || '').toUpperCase()
  if (tour === 'WTA' || gender === 'F' || gender === 'W') return false
  return true
}

function analyzeStrongSets(m, strongSide) {
  const pairs = liveSetPairs(m)
  let strongSets = 0
  let weakSets = 0
  let current = null
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]
    const s = strongSide === 'home' ? p.home : p.away
    const w = strongSide === 'home' ? p.away : p.home
    if (isTennisSetComplete(s, w)) {
      if (s > w) strongSets += 1
      else weakSets += 1
    } else {
      current = { strong: s, weak: w, setIndex: i + 1 }
    }
  }
  return { strongSets, weakSets, current, pairs }
}

function gamesTrailStopLoss(strongG, weakG) {
  return strongG < weakG && (weakG - strongG) > 2
}

/**
 * 盘中止损（文档 §九）：
 * - BO3：第三盘，弱−强 > 2
 * - BO5 路径A（曾 2:0）：第五盘局差 > 2
 * - BO5 路径B（1:1 后变 1:2）：第四盘关键止损；或 2:2 第五盘
 */
function shouldInplayStopLoss(m) {
  if (!isInplayMode.value || !isMatchLive(m) || isMatchEnded(m)) return false
  const side = pickSide(m)
  if (!side) return false
  const { strongSets, weakSets, current } = analyzeStrongSets(m, side)
  if (!current || !gamesTrailStopLoss(current.strong, current.weak)) return false
  if (isBo5Match(m)) {
    if (strongSets === 1 && weakSets === 2 && current.setIndex === 4) return true
    if (strongSets === 2 && weakSets === 2 && current.setIndex === 5) return true
    return false
  }
  return strongSets === 1 && weakSets === 1 && current.setIndex === 3
}

function passesInplayAutoBet(m) {
  if (!isInplayMode.value || !isMatchLive(m) || isMatchEnded(m)) return false
  const side = pickSide(m)
  if (!side) return false
  if (!passesInplayEntryRules(m, data.value?.rankingsByPlayer || {})) return false
  if (!strongWonFirstSet(m)) return false
  const cents = strongPolyPriceCents(m)
  if (cents == null || cents >= 91) return false
  return !!polyUrlOf(m)
}

function canSelectMatch(m) {
  if (isSettledMode.value) return false
  if (!props.isMember || !allowBatchTrade.value) return false
  if (!m?.id || isMatchEnded(m)) return false
  if (!polyUrlOf(m)) return false
  if (isInplayMode.value) return passesInplayAutoBet(m)
  return pickSide(m) != null
}

function isSelected(m) {
  return selectedIds.value.has(String(m.id))
}

function toggleSelect(m) {
  if (!canSelectMatch(m)) return
  const id = String(m.id)
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function clearSelection() {
  selectedIds.value = new Set()
}

const selectedCount = computed(() => selectedIds.value.size)

const pageSelectable = computed(() => paginatedMatches.value.filter(canSelectMatch))

const pageAllSelected = computed(() => {
  const list = pageSelectable.value
  if (!list.length) return false
  return list.every((m) => selectedIds.value.has(String(m.id)))
})

function toggleSelectPage() {
  const list = pageSelectable.value
  if (!list.length) return
  const next = new Set(selectedIds.value)
  if (pageAllSelected.value) {
    for (const m of list) next.delete(String(m.id))
  } else {
    for (const m of list) next.add(String(m.id))
  }
  selectedIds.value = next
}

function buildBatchOrders() {
  return [...selectedIds.value].map((eventId) => {
    const m = matches.value.find((x) => String(x.id) === eventId)
    return { eventId, side: pickSide(m) }
  }).filter((o) => o.side)
}

function formatBatchResultLine(r, list) {
  const m = list.find((x) => String(x.id) === String(r.eventId))
  const label = m
    ? `${matchHomeName(m)} vs ${matchAwayName(m)}`
    : String(r.eventId)
  if (r.ok) {
    const fill = r.takingAmount || r.makingAmount
    return `${label}：已确认${fill ? ` (${fill})` : ''}`
  }
  return `${label}：${r.error || '失败'}`
}

async function submitBatchTrade({ auto = false } = {}) {
  batchError.value = ''
  if (!auto) batchNotice.value = ''
  const orders = buildBatchOrders()
  if (!orders.length) {
    if (!auto) batchError.value = '请先勾选可同步的场次'
    return
  }
  const amount = Number(batchAmountUsd.value)
  if (!(amount >= 1)) {
    batchError.value = '每场金额至少 $1'
    return
  }
  batchSubmitting.value = true
  try {
    const resp = isPrematchMode.value
      ? await api.placeTennisPrematchBatchTrade({ orders, amountUsd: amount })
      : isRangeMode.value
        ? await api.placeTennisRangeBatchTrade({ orders, amountUsd: amount })
        : isLiveMode.value
          ? await api.placeTennisLiveBatchTrade({ orders, amountUsd: amount })
          : isInplayMode.value
            ? await api.placeTennisInplayBatchTrade({ orders, amountUsd: amount })
            : isNewMode.value
              ? await api.placeTennisNewBatchTrade({ orders, amountUsd: amount })
              : await api.placeTennisBatchTrade({ orders, amountUsd: amount })
    const lines = (resp.results || []).map((r) => formatBatchResultLine(r, matches.value))
    if (resp.success > 0) {
      const okLines = lines.filter((_, i) => resp.results[i]?.ok)
      if (auto) {
        batchNotice.value = [
          `自动投注成功 ${resp.success} 场`,
          resp.message || null,
          ...okLines.slice(0, 3),
          okLines.length > 3 ? `…另有 ${okLines.length - 3} 场成功` : null,
        ].filter(Boolean).join('\n')
      } else {
        batchNotice.value = [resp.message, ...okLines].filter(Boolean).join('\n')
      }
      const failed = (resp.results || []).filter((r) => !r.ok).map((r) => String(r.eventId))
      const next = new Set(selectedIds.value)
      const placed = new Set(autoPlacedIds.value)
      for (const o of orders) {
        const id = String(o.eventId)
        if (!failed.includes(id)) {
          next.delete(id)
          placed.add(id)
        }
      }
      selectedIds.value = next
      autoPlacedIds.value = placed
      saveTennisAutoState()
    } else if (!auto) {
      batchNotice.value = ''
    }
    if (resp.failed > 0 || resp.success === 0) {
      batchError.value = lines.filter((_, i) => !resp.results[i]?.ok).join('\n')
        || resp.message
        || '批量同步失败'
    }
  } catch (e) {
    batchError.value = e.response?.data?.error || e.message || '批量同步失败'
  } finally {
    batchSubmitting.value = false
  }
}

async function maybeAutoBatchTrade() {
  if (!autoBetEnabled.value || !allowBatchTrade.value || batchSubmitting.value) return
  const candidates = matches.value.filter((m) => canSelectMatch(m) && !autoPlacedIds.value.has(String(m.id)))
  if (!candidates.length) return
  const next = new Set(selectedIds.value)
  for (const m of candidates) next.add(String(m.id))
  selectedIds.value = next
  await submitBatchTrade({ auto: true })
}

async function maybeAutoStopLoss() {
  if (!isInplayMode.value || !autoBetEnabled.value || !allowBatchTrade.value) return
  if (batchSubmitting.value || stopLossBusy.value) return
  const targets = rawMatches.value.filter((m) => {
    const id = String(m.id)
    if (!autoPlacedIds.value.has(id) || autoSoldIds.value.has(id)) return false
    return shouldInplayStopLoss(m)
  })
  if (!targets.length) return
  stopLossBusy.value = true
  const sold = new Set(autoSoldIds.value)
  const lines = []
  try {
    for (const m of targets) {
      const id = String(m.id)
      const side = pickSide(m)
      if (!side) continue
      try {
        const resp = await api.placeTennisInplaySell({ eventId: id, side, shares: 'all' })
        sold.add(id)
        const label = `${matchHomeName(m)} vs ${matchAwayName(m)}`
        lines.push(`${label}：止损已平仓${resp?.soldShares ? ` (${resp.soldShares})` : ''}`)
      } catch (e) {
        const label = `${matchHomeName(m)} vs ${matchAwayName(m)}`
        lines.push(`${label}：止损失败 ${e.response?.data?.error || e.message || ''}`)
        batchError.value = lines.join('\n')
      }
    }
    if (sold.size !== autoSoldIds.value.size) {
      autoSoldIds.value = sold
      saveTennisAutoState()
    }
    if (lines.some((l) => l.includes('已平仓'))) {
      batchNotice.value = ['自动止损', ...lines.filter((l) => l.includes('已平仓')).slice(0, 5)].join('\n')
    }
  } finally {
    stopLossBusy.value = false
  }
}

function syncInplayPoll() {
  if (inplayPollTimer) {
    clearInterval(inplayPollTimer)
    inplayPollTimer = null
  }
  if (!isInplayMode.value || !autoBetEnabled.value) return
  inplayPollTimer = setInterval(() => {
    loadOnce({ quiet: true })
  }, 60000)
}

watch([filter, tour, gapMin, diffMax, strongRankMax, topPoolMax, pmFilter, settledPnlMark], () => {
  currentPage.value = 1
  clearSelection()
})

watch(() => props.isMember, (ok) => {
  if (!ok) {
    closeDetail()
    clearSelection()
  }
})

watch(totalPages, (pages) => {
  if (currentPage.value > pages) currentPage.value = pages
})

function goPage(page) {
  const p = Math.min(Math.max(1, page), totalPages.value)
  currentPage.value = p
}

function setStatusFilter(mode) {
  if (hideEndedEvents.value && mode === 'ended') return
  if (filter.value === mode) return
  filter.value = mode
  currentPage.value = 1
}

const stats = computed(() => {
  const pool = rawMatches.value.filter((m) => matchPassesTour(m) && matchPassesPm(m))
  const countTab = (tab) => pool.filter((m) => matchPassesFilter(m, tab)).length
  const collected = isInplayMode.value
    ? (data.value?.live?.eventCount ?? data.value?.events ?? pool.length)
    : classicRankFiltersOn.value
      ? countTab(filter.value)
      : (data.value?.events ?? data.value?.scheduled?.eventCount ?? 0)
  return {
    date: data.value?.date || '—',
    tournaments: isInplayMode.value
      ? (data.value?.live?.tournamentCount ?? 0)
      : (data.value?.scheduled?.tournamentCount ?? 0),
    collected,
    total: pool.length,
    all: countTab('all'),
    shown: matches.value.length,
    open: countTab('Not started'),
    live: countTab('liveish'),
    ended: countTab('ended'),
  }
})

const filterSummary = computed(() => {
  const parts = []
  if (filter.value === 'Not started') parts.push('未开始')
  else if (filter.value === 'liveish') parts.push('进行中')
  else if (filter.value === 'ended') parts.push('已结束')
  else parts.push('全部状态')
  if (tour.value === 'ATP') parts.push('男子')
  else if (tour.value === 'WTA') parts.push('女子')
  if (pmFilter.value === 'yes') parts.push('有PM')
  else if (pmFilter.value === 'no') parts.push('无PM')
  if (classicRankFiltersOn.value) {
    if (gapMin.value !== 'all') parts.push(`现差≥${gapMin.value}`)
    if (diffMax.value !== 'all') {
      parts.push(diffMax.value === '0' ? '排差<0' : `排差≤${diffMax.value}`)
    }
    if (strongRankMax.value !== 'all') parts.push(`强者现≤${strongRankMax.value}`)
  } else if (isSettledMode.value) {
    if (settledPnlMark.value === 'bet') parts.push('有投注')
    else if (settledPnlMark.value === 'win') parts.push('盈利')
    else if (settledPnlMark.value === 'loss') parts.push('亏损')
  } else if (props.isMember) {
    if (isRangeMode.value) parts.push(RANGE_RULES_TEXT)
    else if (isNewMode.value) parts.push(`Top${topPoolMax.value}`)
  }
  return parts.join(' · ')
})

function sanitizeBundleHint(raw) {
  const msg = String(raw || '').trim()
  if (!msg) return ''
  return msg
    .replace(/sofascore/gi, '')
    .replace(/from\s+monitor\s*→\s*redis/gi, '采集写入 Redis')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const bundleHint = computed(() => {
  const msg = data.value?.message || data.value?.update?.message || ''
  return sanitizeBundleHint(msg)
})

function eloOf(id) {
  const map = data.value?.eloByEvent || {}
  return map[id] || map[String(id)] || null
}
function oddsOf(id) {
  const map = data.value?.oddsByEvent || {}
  return map[id] || map[String(id)] || null
}
function polyOf(id) {
  const map = data.value?.polymarketByEvent || {}
  return map[id] || map[String(id)] || null
}

/** 建议投注侧：现排名更高（数字更小）的一侧；缺一方排名则不建议 */
function pickSide(m) {
  if (!m) return null
  const home = m.homePlayer || { name: m.home, ranking: null }
  const away = m.awayPlayer || { name: m.away, ranking: null }
  const homeR = currentRankOf(home)
  const awayR = currentRankOf(away)
  if (homeR == null || awayR == null) return null
  if (homeR === awayR) return null
  return homeR < awayR ? 'home' : 'away'
}

function matchHomeName(m) {
  return m?.homePlayer?.name || m?.home || '—'
}
function matchAwayName(m) {
  return m?.awayPlayer?.name || m?.away || '—'
}
function listRankOf(m, side) {
  const player = side === 'home'
    ? (m.homePlayer || { name: m.home, ranking: null })
    : (m.awayPlayer || { name: m.away, ranking: null })
  return currentRankOf(player)
}
function matchGenderLabel(m) {
  const g = m?.gender || m?.homePlayer?.gender || m?.awayPlayer?.gender
  return g === 'F' ? '女子' : '男子'
}
function matchGenderClass(m) {
  const g = m?.gender || m?.homePlayer?.gender || m?.awayPlayer?.gender
  return g === 'F' ? 'gender-f' : 'gender-m'
}
function matchTourTitle(m) {
  const name = String(m?.tournamentShort || m?.tournament || '').replace(/,.*/, '').trim()
  if (!name) return '—'
  return m?.roundLabel ? `${name} · ${m.roundLabel}` : name
}
function levelShort(raw) {
  const s = String(raw || '').trim()
  const lower = s.toLowerCase()
  if (!lower) return ''
  if (lower.includes('grand_slam') || lower.includes('grand slam') || /\bgs\b/.test(lower)) return 'GS'
  if (lower.includes('masters') || /\b1000\b/.test(lower)) return '1000'
  if (/\b500\b/.test(lower)) return '500'
  if (/\b250\b/.test(lower)) return '250'
  return s.replace(/^(atp|wta)\s+/i, '').trim() || s
}
function matchLevelLabel(m) {
  const tour = String(m?.tour || ((m?.gender || m?.homePlayer?.gender || m?.awayPlayer?.gender) === 'F' ? 'wta' : 'atp')).toUpperCase()
  const raw = String(m?.level || '').trim()
  if (!raw) return tour

  // level 已含 ATP/WTA 前缀（如 "ATP GS"）时直接规范化，避免拼成 "ATP ATP GS"
  const prefixed = raw.match(/^(ATP|WTA)\s+(.+)$/i)
  if (prefixed) {
    const prefix = prefixed[1].toUpperCase()
    const short = levelShort(prefixed[2])
    return short && short.toUpperCase() !== prefix ? `${prefix} ${short}` : prefix
  }

  const short = levelShort(raw)
  if (!short || short.toUpperCase() === tour) return tour
  return `${tour} ${short}`
}
function polyUrlOf(m) {
  const url = String(polyOf(m?.id)?.url || '')
  return /polymarket\.com\/event\//i.test(url) ? url : ''
}
function openDetail(m) {
  if (!props.isMember) return
  detailHelpOpen.value = false
  detailMatch.value = m
}
function closeDetail() {
  detailMatch.value = null
  detailHelpOpen.value = false
}
function toggleDetailHelp(ev) {
  ev?.stopPropagation?.()
  detailHelpOpen.value = !detailHelpOpen.value
}
function openMarket(m) {
  if (!props.isMember) return
  const url = polyUrlOf(m)
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  // 与采集端一致：统一按北京时间显示，避免浏览器时区导致“开赛时间不对”
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 开赛日与今天（北京时间）是否同一天 */
function isStartSameDay(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return false
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const startDay = fmt.format(new Date(n * 1000))
  const todayDay = fmt.format(new Date(nowSec.value * 1000))
  return startDay === todayDay
}

function fmtEdge(v) {
  if (v == null || Number.isNaN(Number(v))) return '—'
  const n = Number(v)
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

function fmtOdds(side) {
  const d = side?.decimal
  if (d == null || Number.isNaN(Number(d))) return '—'
  return Number(d).toFixed(2)
}

function oddsSourceLabel(id) {
  const raw = oddsOf(id)?.source || oddsOf(id)?.full_time?.source || ''
  const s = String(raw).trim().toLowerCase()
  if (!s || s.includes('sofa') || s === 'ipwo' || s.includes('monitor')) return ''
  return raw
}

function lastToken(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/)
  return (parts[parts.length - 1] || '').toLowerCase()
}

function polySideCents(poly, homeName, awayName) {
  const ml = poly?.moneyline
  const outcomes = ml?.outcomes || []
  const prices = ml?.prices || []
  if (!outcomes.length || !prices.length) return { home: null, away: null }
  const homeLast = lastToken(homeName)
  const awayLast = lastToken(awayName)
  let homeIdx = outcomes.findIndex((n) => lastToken(n) === homeLast)
  let awayIdx = outcomes.findIndex((n) => lastToken(n) === awayLast)
  if (homeIdx < 0 && awayIdx < 0) { homeIdx = 0; awayIdx = 1 }
  else if (homeIdx < 0) homeIdx = awayIdx === 0 ? 1 : 0
  else if (awayIdx < 0) awayIdx = homeIdx === 0 ? 1 : 0
  const hp = Number(prices[homeIdx])
  const ap = Number(prices[awayIdx])
  if (!Number.isFinite(hp) || !Number.isFinite(ap)) return { home: null, away: null }
  // 独立四舍五入会出现 74.5→75、25.5→26 合计 101；按占比归一到 100
  let home = Math.round(hp * 100)
  let away = Math.round(ap * 100)
  const sum = home + away
  if (sum > 0 && sum !== 100) {
    if (home >= away) home += 100 - sum
    else away += 100 - sum
  }
  return { home, away }
}

function statusText(m) {
  if (isMatchEnded(m)) return '已结束'
  if (isMatchLive(m)) return '进行中'
  const s = effectiveStatus(m)
  if (s === 'Not started') return '未开赛'
  if (s === 'Ended') return '已结束'
  return s || '—'
}

function scoreValue(v) {
  if (v == null || v === '') return null
  if (typeof v === 'object') {
    const cur = v.current ?? v.display ?? v.score
    return cur == null || cur === '' ? null : Number(cur)
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function matchScoreText(m) {
  if (!m || !isMatchLive(m)) return ''
  const hs = playerLiveScoreText(m, 'home')
  const as = playerLiveScoreText(m, 'away')
  if (!hs && !as) return ''
  return `${hs || 0} - ${as || 0}`
}

function parseScoreTextSides(text) {
  if (!text) return null
  const sets = String(text).replace(/,\s*/g, ' ').trim().split(/\s+/).filter(Boolean)
  const home = []
  const away = []
  for (const part of sets) {
    const m = part.match(/^(\d+)-(\d+)$/)
    if (!m) continue
    home.push(m[1])
    away.push(m[2])
  }
  if (!home.length) return null
  // 当前盘 0-0 尚未开打时不显示末尾占位
  if (home.length > 1 && home[home.length - 1] === '0' && away[away.length - 1] === '0') {
    home.pop()
    away.pop()
  }
  if (!home.length) return null
  return { home: home.join(' '), away: away.join(' ') }
}

function parsePeriodScoreSides(m) {
  const hs = m.home_score ?? m.homeScore
  const as = m.away_score ?? m.awayScore
  if (!hs || typeof hs !== 'object' || !as || typeof as !== 'object') return null
  const home = []
  const away = []
  for (const key of ['period1', 'period2', 'period3', 'period4', 'period5']) {
    if (hs[key] != null && as[key] != null) {
      home.push(String(hs[key]))
      away.push(String(as[key]))
    }
  }
  if (!home.length) return null
  return { home: home.join(' '), away: away.join(' ') }
}

function liveSetPairs(m) {
  const combined = m.scoreText || m.score_text || (typeof m.score === 'string' ? m.score : '')
  if (combined) {
    const parts = String(combined).replace(/,\s*/g, ' ').trim().split(/\s+/).filter(Boolean)
    const pairs = []
    for (const part of parts) {
      const hit = part.match(/^(\d+)-(\d+)$/)
      if (!hit) continue
      pairs.push({ home: Number(hit[1]), away: Number(hit[2]) })
    }
    if (pairs.length > 1 && pairs[pairs.length - 1].home === 0 && pairs[pairs.length - 1].away === 0) {
      pairs.pop()
    }
    if (pairs.length) return pairs
  }
  const hs = m.home_score ?? m.homeScore
  const as = m.away_score ?? m.awayScore
  if (!hs || typeof hs !== 'object' || !as || typeof as !== 'object') return []
  const pairs = []
  for (const key of ['period1', 'period2', 'period3', 'period4', 'period5']) {
    if (hs[key] != null && as[key] != null) {
      pairs.push({ home: Number(hs[key]), away: Number(as[key]) })
    }
  }
  return pairs
}

function liveSetCells(m, side) {
  return liveSetPairs(m).map((p) => {
    const mine = side === 'home' ? p.home : p.away
    const opp = side === 'home' ? p.away : p.home
    let cls = 'score-even'
    if (mine > opp) cls = 'score-big'
    else if (mine < opp) cls = 'score-small'
    return { text: String(mine), cls }
  })
}

function livePointText(m, side) {
  const raw = side === 'home' ? (m.home_score ?? m.homeScore) : (m.away_score ?? m.awayScore)
  if (raw && typeof raw === 'object' && raw.point != null && raw.point !== '' && raw.point !== '0') {
    return String(raw.point)
  }
  return ''
}

function playerLiveScoreText(m, side) {
  if (!isMatchLive(m)) return ''
  const combined = m.scoreText || m.score_text || (typeof m.score === 'string' ? m.score : '')
  if (combined) {
    const parsed = parseScoreTextSides(combined)
    if (parsed?.[side]) return parsed[side]
  }
  const periods = parsePeriodScoreSides(m)
  if (periods?.[side]) return periods[side]
  const raw = side === 'home' ? (m.home_score ?? m.homeScore) : (m.away_score ?? m.awayScore)
  if (raw == null || raw === '') return ''
  if (typeof raw === 'object') {
    const cur = raw.current ?? raw.display ?? raw.score
    if (cur != null && cur !== '') return String(cur)
    return ''
  }
  return String(raw)
}

/** 打开页面时从 Redis 加载；quiet 时用于盘中自动轮询 */
async function loadOnce({ quiet = false } = {}) {
  if (!quiet) {
    error.value = ''
    loading.value = true
  }
  try {
    const token = localStorage.getItem('token') || ''
    const res = await fetch(`${apiPath.value}/today`, {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const errBody = await res.json()
        if (errBody?.error) msg = errBody.error
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    const payload = await res.json()
    const bundle =
      payload?.live != null || payload?.scheduled != null || payload?.rankingsByPlayer != null
        ? payload
        : payload?.data || payload
    data.value = bundle
    if (bundle?.serverTime != null) {
      serverTimeBase.value = Number(bundle.serverTime)
      loadedAtMs.value = Date.now()
    }
    if (isSettledMode.value) {
      try {
        settledStats.value = await api.fetchTennisSettledStats()
      } catch {
        settledStats.value = null
      }
    } else {
      settledStats.value = null
    }
    await maybeAutoStopLoss()
    await maybeAutoBatchTrade()
  } catch (e) {
    if (!quiet) error.value = e?.message || '加载失败'
  } finally {
    if (!quiet) loading.value = false
  }
}

onMounted(() => {
  loadTennisAutoState()
  if (isPrematchMode.value) {
    tour.value = 'all'
    pmFilter.value = 'all'
    filter.value = 'Not started'
  } else if (isInplayMode.value) {
    tour.value = 'all'
    pmFilter.value = 'all'
    filter.value = 'all'
  } else if (isSettledMode.value) {
    tour.value = 'all'
    pmFilter.value = 'all'
    settledPnlMark.value = 'all'
    filter.value = 'ended'
  } else if (hideEndedEvents.value && filter.value === 'ended') {
    filter.value = 'Not started'
  }
  loadOnce()
  syncInplayPoll()
  tickTimer = setInterval(() => { clockTick.value++ }, 30000)
})

watch(
  () => [
    data.value?.upstream || data.value?.source || data.value?.dataSource,
    isPrematchMode.value,
    isInplayMode.value,
    isClassicMode.value,
    isSettledMode.value,
  ],
  ([src]) => {
    if (String(src || '') !== 'docks500') return
    if (isPrematchMode.value || isClassicMode.value) {
      if (gapMin.value === '50') gapMin.value = 'all'
      if (diffMax.value === '0') diffMax.value = 'all'
      if (strongRankMax.value === '20') strongRankMax.value = 'all'
    }
    if (isPrematchMode.value && filter.value !== 'Not started' && filter.value !== 'all') {
      filter.value = 'Not started'
    }
    if (isInplayMode.value) {
      filter.value = 'all'
    }
    if (isClassicMode.value && filter.value === 'Not started') {
      filter.value = 'ended'
    }
    if (isSettledMode.value) {
      filter.value = 'ended'
    }
  },
)

watch(
  [tour, pmFilter, gapMin, diffMax, strongRankMax, settledPnlMark],
  () => {
    if (isPrematchMode.value) {
      saveFilters('prematch', {
        tour: tour.value,
        pm: pmFilter.value,
      })
    } else if (isInplayMode.value) {
      saveFilters('inplay', {
        tour: tour.value,
        pm: pmFilter.value,
      })
    } else if (isSettledMode.value) {
      saveFilters('settled', {
        tour: tour.value,
        pm: pmFilter.value,
        pnlMark: settledPnlMark.value,
      })
    }
  },
)
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (inplayPollTimer) {
    clearInterval(inplayPollTimer)
    inplayPollTimer = null
  }
})

function gapInfo(m) {
  if (isInplayMode.value) {
    const metrics = matchInplayRankMetrics(m, data.value?.rankingsByPlayer || {})
    if (!metrics.ready) return { ready: false }
    return {
      ready: true,
      gap: metrics.gap,
      homeR: metrics.homeR,
      awayR: metrics.awayR,
      strongNow: metrics.strongRank,
      minGap: metrics.minGap,
      tier: inplayTierLabel(metrics.strongRank),
    }
  }
  if (isRangeMode.value || isNewMode.value) {
    const metrics = matchRangeMetrics(m, data.value?.rankingsByPlayer || {})
    if (!metrics.ready) return { ready: false }
    return {
      ready: true,
      gap: metrics.gap,
      homeR: metrics.homeR,
      awayR: metrics.awayR,
      strongNow: metrics.strongRank,
      minGap: metrics.minGap,
      tier: tierLabel(metrics.strongRank),
    }
  }
  const home = m.homePlayer || { name: m.home }
  const away = m.awayPlayer || { name: m.away }
  const homeR = currentRankOf(home)
  const awayR = currentRankOf(away)
  if (homeR == null || awayR == null) return { ready: false }
  // 现排名差 = 弱−强；历史最高排名差 = 高−低
  const gap = Math.max(homeR, awayR) - Math.min(homeR, awayR)
  const homeStronger = homeR < awayR
  const better = homeStronger ? shortName(home.name) : shortName(away.name)
  const strongNow = homeStronger ? homeR : awayR
  const weakNow = homeStronger ? awayR : homeR
  const homeDetail = rankDetailOf(home, m)
  const awayDetail = rankDetailOf(away, m)
  const homeBest = homeDetail.best != null ? Number(homeDetail.best) : null
  const awayBest = awayDetail.best != null ? Number(awayDetail.best) : null
  const hasBest = Number.isFinite(homeBest) && Number.isFinite(awayBest)
  const bestHigh = hasBest ? Math.min(homeBest, awayBest) : null
  const bestLow = hasBest ? Math.max(homeBest, awayBest) : null
  const rankDiff = hasBest ? bestHigh - bestLow : null
  return {
    ready: true,
    gap,
    homeR,
    awayR,
    better,
    strongNow,
    weakNow,
    homeBest,
    awayBest,
    bestHigh,
    bestLow,
    rankDiff,
  }
}

function settledPnlBadge(m) {
  if (!isSettledMode.value || !m?.id) return null
  const id = String(m.id)
  const stats = settledStats.value
  if (!stats) return null
  const mark = stats.pnlByEvent?.[id]
  const hasBet = stats.betEventIds?.[id] === true || mark != null
  if (mark != null && mark > 0) return { text: '盈', cls: 'pnl-win' }
  if (mark != null && mark < 0) return { text: '亏', cls: 'pnl-loss' }
  if (mark != null && mark === 0) return { text: '平', cls: 'pnl-flat' }
  if (hasBet) return { text: '投', cls: 'pnl-bet' }
  return null
}
</script>

<template>
  <div class="wrap">
    <div v-if="isInplayMode && (allowBatchTrade || bundleHint)" class="inplay-source-bar">
      <span v-if="allowBatchTrade" class="inplay-auto-rules">自动投注：{{ INPLAY_AUTO_RULES_TEXT }}</span>
      <span v-if="bundleHint">{{ allowBatchTrade ? ' · ' : '' }}{{ bundleHint }}</span>
    </div>
    <div v-if="isSettledMode && settledStats" class="settled-stats-bar">
      <span>合计 盈{{ pct(settledStats.total?.winRate) }} / 亏{{ pct(settledStats.total?.lossRate) }} · PnL {{ num(settledStats.total?.totalPnl) }}</span>
      <span>盘前 盈{{ pct(settledStats.prematch?.winRate) }} / 亏{{ pct(settledStats.prematch?.lossRate) }}</span>
      <span>盘中 盈{{ pct(settledStats.inplay?.winRate) }} / 亏{{ pct(settledStats.inplay?.lossRate) }}</span>
      <template v-if="(settledStats.rules || []).length">
        <span
          v-for="r in settledStats.rules"
          :key="r.key || r.id"
          class="settled-rule-stat"
          :title="(r.bucket === 'prematch' ? '盘前' : '盘中') + ' · ' + (r.source === 'trade' ? '真实成交' : '纸面回测') + ' · n=' + (r.settledCount || 0)"
        >
          {{ r.bucket === 'prematch' ? '前' : '中' }}·{{ r.name }}
          盈{{ pct(r.winRate) }} / 亏{{ pct(r.lossRate) }}
          · {{ num(r.totalPnl) }}
          <em v-if="r.source === 'paper'">纸</em>
        </span>
      </template>
      <span v-else class="settled-rule-hint">未配置投注条件组时不按规则拆分</span>
    </div>

    <div class="topbar">
      <span class="meta-chip">{{ stats.date }}</span>
      <span class="meta-chip">{{ loading ? '…' : `${stats.shown}/${stats.all}` }}</span>
      <div class="stats">
        <div class="stat"><b>{{ stats.tournaments }}</b><span>赛</span></div>
        <div class="stat"><b>{{ stats.collected }}</b><span>总</span></div>
        <button type="button" class="stat stat-btn" :class="{ active: filter === 'all' }" @click="setStatusFilter('all')">
          <b>{{ stats.all }}</b><span>全</span>
        </button>
        <button v-if="!isInplayMode" type="button" class="stat stat-btn" :class="{ active: filter === 'Not started' }" @click="setStatusFilter('Not started')">
          <b>{{ stats.open }}</b><span>未开</span>
        </button>
        <button v-if="!isInplayMode" type="button" class="stat stat-btn" :class="{ active: filter === 'liveish' }" @click="setStatusFilter('liveish')">
          <b>{{ stats.live }}</b><span>进行</span>
        </button>
        <button
          v-if="!hideEndedEvents"
          type="button"
          class="stat stat-btn"
          :class="{ active: filter === 'ended' }"
          @click="setStatusFilter('ended')"
        >
          <b>{{ stats.ended }}</b><span>结束</span>
        </button>
      </div>
    </div>

    <div v-if="isMember && isNewMode" class="new-pool-bar">
      <span class="label">排名池</span>
      <button type="button" class="chip-btn" :class="{ active: topPoolMax === '20' }" @click="topPoolMax = '20'">Top20</button>
      <button type="button" class="chip-btn" :class="{ active: topPoolMax === '50' }" @click="topPoolMax = '50'">Top50</button>
      <span class="new-pool-hint">{{ NEW_POOL_RULES_TEXT }}</span>
    </div>

    <div v-if="showFilters && !isPrematchMode && !isInplayMode && !isSettledMode" class="filter-panel">
      <button type="button" class="filter-toggle" @click="filtersOpen = !filtersOpen">
        <span class="filter-toggle-main">
          <span class="filter-toggle-title">筛选</span>
          <span class="filter-toggle-summary">{{ filterSummary }}</span>
        </span>
        <span class="filter-toggle-arrow" :class="{ open: filtersOpen }">▾</span>
      </button>

      <div v-show="filtersOpen" class="filter-body">
        <div v-if="!isInplayMode && !isPrematchMode && !isSettledMode" class="filters">
          <button type="button" :class="{ active: filter === 'all' }" @click="setStatusFilter('all')">全部</button>
          <button type="button" :class="{ active: filter === 'Not started' }" @click="setStatusFilter('Not started')">未开始</button>
          <button type="button" :class="{ active: filter === 'liveish' }" @click="setStatusFilter('liveish')">进行中</button>
          <button v-if="!hideEndedEvents" type="button" :class="{ active: filter === 'ended' }" @click="setStatusFilter('ended')">已结束</button>
        </div>

        <div class="filter-row">
          <span class="label">巡回</span>
          <button type="button" class="chip-btn" :class="{ active: tour === 'all' }" @click="tour = 'all'">全部</button>
          <button type="button" class="chip-btn" :class="{ active: tour === 'ATP' }" @click="tour = 'ATP'">男</button>
          <button type="button" class="chip-btn" :class="{ active: tour === 'WTA' }" @click="tour = 'WTA'">女</button>
        </div>

        <div class="filter-row">
          <span class="label">PM</span>
          <button type="button" class="chip-btn" :class="{ active: pmFilter === 'all' }" @click="pmFilter = 'all'">全部</button>
          <button type="button" class="chip-btn" :class="{ active: pmFilter === 'yes' }" @click="pmFilter = 'yes'">有外链</button>
          <button type="button" class="chip-btn" :class="{ active: pmFilter === 'no' }" @click="pmFilter = 'no'">无外链</button>
        </div>

        <template v-if="isSettledMode">
          <div class="filter-row">
            <span class="label">盈亏</span>
            <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'all' }" @click="settledPnlMark = 'all'">全部</button>
            <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'bet' }" @click="settledPnlMark = 'bet'">有投注</button>
            <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'win' }" @click="settledPnlMark = 'win'">盈利</button>
            <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'loss' }" @click="settledPnlMark = 'loss'">亏损</button>
          </div>
        </template>

        <template v-else-if="classicRankFiltersOn">
          <div class="filter-row">
            <span class="label">现差</span>
            <button type="button" class="chip-btn" :class="{ active: gapMin === 'all' }" @click="gapMin = 'all'">不限</button>
            <button type="button" class="chip-btn" :class="{ active: gapMin === '50' }" @click="gapMin = '50'">≥50</button>
            <button type="button" class="chip-btn" :class="{ active: gapMin === '70' }" @click="gapMin = '70'">≥70</button>
            <button type="button" class="chip-btn" :class="{ active: gapMin === '90' }" @click="gapMin = '90'">≥90</button>
          </div>

          <div class="filter-row">
            <span class="label">排差</span>
            <button type="button" class="chip-btn" :class="{ active: diffMax === 'all' }" @click="diffMax = 'all'">不限</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '0' }" @click="diffMax = '0'">&lt;0</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '-30' }" @click="diffMax = '-30'">≤-30</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '-50' }" @click="diffMax = '-50'">≤-50</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '-70' }" @click="diffMax = '-70'">≤-70</button>
          </div>

          <div class="filter-row">
            <span class="label">强现</span>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === 'all' }" @click="strongRankMax = 'all'">不限</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '10' }" @click="strongRankMax = '10'">≤10</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '20' }" @click="strongRankMax = '20'">≤20</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '50' }" @click="strongRankMax = '50'">≤50</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '100' }" @click="strongRankMax = '100'">≤100</button>
          </div>
        </template>
        <div v-else-if="isMember && isRangeMode" class="filter-row range-rules">
          <span class="label">区间</span>
          <span class="range-rules-text">{{ RANGE_RULES_TEXT }}</span>
        </div>
      </div>
    </div>

    <div v-if="loading && !data" class="empty">加载赛程中…</div>
    <div v-else-if="error && !data" class="empty err">{{ error }}</div>
    <div v-else-if="!matches.length && !isInplayMode" class="empty">
      当前筛选下没有场次（池内 {{ stats.total }} 场 · 符合筛选 {{ stats.shown }} 场）
      <div v-if="bundleHint" class="hint">{{ bundleHint }}</div>
    </div>
    <div v-else-if="!matches.length && isInplayMode" class="empty" role="status">
      暂无数据
    </div>

    <template v-else>
    <div v-if="allowBatchTrade" class="batch-bar">
      <div class="batch-bar-controls">
        <label class="auto-bet-toggle" :class="{ on: autoBetEnabled }">
          <input type="checkbox" :checked="autoBetEnabled" @change="toggleAutoBet" />
          <span>自动投注</span>
        </label>
        <label class="batch-check-all">
          <input
            type="checkbox"
            :checked="pageAllSelected && pageSelectable.length > 0"
            :disabled="!pageSelectable.length"
            @change="toggleSelectPage"
          />
          <span>全选</span>
        </label>
        <span class="batch-count">{{ selectedCount }}</span>
        <label class="batch-amount">
          <span>$</span>
          <input v-model="batchAmountUsd" type="number" min="1" step="1" inputmode="decimal" />
        </label>
        <button
          type="button"
          class="batch-btn"
          :disabled="batchSubmitting || selectedCount === 0"
          @click="submitBatchTrade()"
        >{{ batchSubmitting ? '…' : '批量' }}</button>
        <button
          v-if="selectedCount"
          type="button"
          class="batch-clear"
          :disabled="batchSubmitting"
          @click="clearSelection"
        >清</button>
      </div>
      <div v-if="batchNotice" class="batch-notice">{{ batchNotice }}</div>
      <div v-if="batchError" class="batch-error">{{ batchError }}</div>
    </div>

    <div class="list">
      <article
        v-for="m in paginatedMatches"
        :key="m.id"
        class="row-card"
        :class="{ selected: isSelected(m), selectable: canSelectMatch(m) }"
      >
        <label v-if="allowBatchTrade" class="row-check" :class="{ disabled: !canSelectMatch(m) }">
          <input
            type="checkbox"
            :checked="isSelected(m)"
            :disabled="!canSelectMatch(m)"
            @change="toggleSelect(m)"
          />
        </label>
        <div class="row-body">
        <div class="row-time">
          <span class="start-value" :class="{ today: isStartSameDay(m.startTimestamp) }">{{ fmtTime(m.startTimestamp) }}</span>
          <span class="start-status" :class="{ live: isMatchLive(m) }">{{ statusText(m) }}</span>
          <span class="tour-title">{{ matchTourTitle(m) }}</span>
          <div class="badges">
            <span class="badge" :class="matchGenderClass(m)">{{ matchGenderLabel(m) }}</span>
            <span class="badge level">{{ matchLevelLabel(m) }}</span>
            <span v-if="isMember && oddsOf(m.id)?.full_time" class="badge odds">报</span>
            <span v-if="isMember && polyOf(m.id)?.url" class="badge poly">外</span>
            <span v-if="isMember && isNewMode && gapInfo(m).ready" class="badge live-tier">{{ gapInfo(m).tier }}</span>
            <span
              v-if="isInplayMode && gapInfo(m).ready"
              class="badge live-tier"
              :title="`现差 ${gapInfo(m).gap} · 需≥${gapInfo(m).minGap}`"
            >{{ gapInfo(m).tier }} · 差{{ gapInfo(m).gap }}</span>
            <span
              v-if="settledPnlBadge(m)"
              class="badge"
              :class="settledPnlBadge(m).cls"
            >{{ settledPnlBadge(m).text }}</span>
          </div>
        </div>
        <div class="row-main">
          <div v-if="isMatchLive(m)" class="matchup is-live-board">
            <div class="matchup-line">
              <span class="name live-player-top" :class="{ pick: isMember && pickSide(m) === 'home', 'live-side': true }">
                <span v-if="isMember && listRankOf(m, 'home') != null" class="list-rank">#{{ listRankOf(m, 'home') }}</span>
                <span class="player-name">{{ matchHomeName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'home'" class="pick-tag">优</span>
              </span>
              <div class="live-set-scores" aria-label="主队盘分">
                <span
                  v-for="(cell, idx) in liveSetCells(m, 'home')"
                  :key="'h' + idx"
                  class="set-cell"
                  :class="cell.cls"
                >{{ cell.text }}</span>
                <span v-if="livePointText(m, 'home')" class="live-point">{{ livePointText(m, 'home') }}</span>
              </div>
            </div>
            <span class="vs-row">VS</span>
            <div class="matchup-line">
              <span class="name live-player-bottom" :class="{ pick: isMember && pickSide(m) === 'away', 'live-side': true }">
                <span v-if="isMember && listRankOf(m, 'away') != null" class="list-rank">#{{ listRankOf(m, 'away') }}</span>
                <span class="player-name">{{ matchAwayName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'away'" class="pick-tag">优</span>
              </span>
              <div class="live-set-scores" aria-label="客队盘分">
                <span
                  v-for="(cell, idx) in liveSetCells(m, 'away')"
                  :key="'a' + idx"
                  class="set-cell"
                  :class="cell.cls"
                >{{ cell.text }}</span>
                <span v-if="livePointText(m, 'away')" class="live-point">{{ livePointText(m, 'away') }}</span>
              </div>
            </div>
          </div>
          <div v-else class="matchup is-stacked">
            <div class="matchup-line">
              <span class="name" :class="{ pick: isMember && pickSide(m) === 'home' }">
                <span v-if="isMember && listRankOf(m, 'home') != null" class="list-rank">#{{ listRankOf(m, 'home') }}</span>
                <span class="player-name">{{ matchHomeName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'home'" class="pick-tag">优</span>
              </span>
            </div>
            <span class="vs-row">VS</span>
            <div class="matchup-line">
              <span class="name" :class="{ pick: isMember && pickSide(m) === 'away' }">
                <span v-if="isMember && listRankOf(m, 'away') != null" class="list-rank">#{{ listRankOf(m, 'away') }}</span>
                <span class="player-name">{{ matchAwayName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'away'" class="pick-tag">优</span>
              </span>
            </div>
          </div>
          <div v-if="isMember" class="row-actions">
            <button type="button" class="act-btn" @click="openDetail(m)">详情</button>
            <button
              type="button"
              class="act-btn market"
              :disabled="!polyUrlOf(m)"
              :title="polyUrlOf(m) ? '打开关联页' : '暂无对应外链'"
              @click="openMarket(m)"
            >外链</button>
          </div>
        </div>
        </div>
      </article>
    </div>

    <div v-if="totalPages > 1" class="pager">
      <button type="button" class="pager-btn" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">上一页</button>
      <span class="pager-info">第 {{ currentPage }} / {{ totalPages }} 页</span>
      <button type="button" class="pager-btn" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">下一页</button>
    </div>
    </template>

    <Teleport to="body">
      <div v-if="detailMatch" class="modal-mask" @click.self="closeDetail">
        <div class="modal-sheet" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="modal-head-main">
              <div class="modal-title">详情</div>
              <div class="modal-sub">
                {{ shortName(matchHomeName(detailMatch)) }} vs {{ shortName(matchAwayName(detailMatch)) }}
              </div>
              <div class="modal-meta">
                <span>{{ (detailMatch.tournamentShort || detailMatch.tournament || '').replace(/,.*/, '') }}</span>
                <template v-if="detailMatch.roundLabel"> · {{ detailMatch.roundLabel }}</template>
                · <span :class="{ today: isStartSameDay(detailMatch.startTimestamp) }">{{ fmtTime(detailMatch.startTimestamp) }}</span>
                · {{ statusText(detailMatch) }}
                <template v-if="detailMatch.groundLabel"> · {{ detailMatch.groundLabel }}</template>
              </div>
              <div class="badges modal-badges">
                <span
                  class="badge"
                  :class="(detailMatch.gender || detailMatch.homePlayer?.gender || detailMatch.awayPlayer?.gender) === 'F' ? 'gender-f' : 'gender-m'"
                >{{ (detailMatch.gender || detailMatch.homePlayer?.gender || detailMatch.awayPlayer?.gender) === 'F' ? '女' : '男' }}</span>
                <span class="badge level">{{ matchLevelLabel(detailMatch) }}</span>
                <span v-if="oddsOf(detailMatch.id)?.full_time" class="badge odds">报</span>
                <span v-if="polyOf(detailMatch.id)?.url" class="badge poly">外</span>
                <span
                  v-if="isInplayMode && gapInfo(detailMatch).ready"
                  class="badge live-tier"
                >{{ gapInfo(detailMatch).tier }} · 差{{ gapInfo(detailMatch).gap }}</span>
                <span v-if="pickSide(detailMatch)" class="badge pick">优{{ pickSide(detailMatch) === 'home' ? shortName(matchHomeName(detailMatch)) : shortName(matchAwayName(detailMatch)) }}</span>
              </div>
            </div>
            <div class="modal-head-actions">
              <button
                type="button"
                class="help-bang modal-help-bang"
                :class="{ on: detailHelpOpen }"
                title="字段说明"
                aria-label="字段说明"
                @click="toggleDetailHelp($event)"
              >!</button>
              <button type="button" class="modal-x" @click="closeDetail" aria-label="关闭">×</button>
            </div>
          </div>

          <div v-if="detailHelpOpen" class="modal-help-panel">
            <div class="modal-help-title">字段说明</div>
            <ul class="modal-help-list">
              <li v-for="item in DETAIL_TIPS" :key="item.k">
                <b>{{ item.k }}</b>：{{ item.t }}
              </li>
            </ul>
          </div>

          <div class="modal-body">
            <div class="duel">
              <div class="duel-side" :class="{ pick: pickSide(detailMatch) === 'home' }">
                <div class="duel-top">
                  <span class="duel-rank">#{{ rankText(currentRankOf(detailMatch.homePlayer || { name: detailMatch.home })) }}</span>
                  <span class="duel-score" v-if="playerLiveScoreText(detailMatch, 'home')">{{ playerLiveScoreText(detailMatch, 'home') }}</span>
                </div>
                <div class="duel-name">{{ playerNameWithAge(detailMatch.homePlayer || { name: detailMatch.home }, eloOf(detailMatch.id)?.home) }}</div>
                <div class="duel-sub">
                  周{{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).previous) }}
                  · <span class="rank-best">高{{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).best) }}</span>
                  · L{{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).live) }}
                  · U{{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).utr) }}
                </div>
              </div>
              <div class="duel-vs">VS</div>
              <div class="duel-side" :class="{ pick: pickSide(detailMatch) === 'away' }">
                <div class="duel-top">
                  <span class="duel-rank">#{{ rankText(currentRankOf(detailMatch.awayPlayer || { name: detailMatch.away })) }}</span>
                  <span class="duel-score" v-if="playerLiveScoreText(detailMatch, 'away')">{{ playerLiveScoreText(detailMatch, 'away') }}</span>
                </div>
                <div class="duel-name">{{ playerNameWithAge(detailMatch.awayPlayer || { name: detailMatch.away }, eloOf(detailMatch.id)?.away) }}</div>
                <div class="duel-sub">
                  周{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).previous) }}
                  · <span class="rank-best">高{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).best) }}</span>
                  · L{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).live) }}
                  · U{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).utr) }}
                </div>
              </div>
            </div>

            <div class="kv-grid">
              <template v-if="gapInfo(detailMatch).ready">
                <div class="kv" v-if="isRangeMode || isNewMode || isInplayMode">
                  <span class="k">{{ isInplayMode ? '盘中档' : (isNewMode ? '档位' : '区间') }}</span>
                  <span class="v">{{ gapInfo(detailMatch).tier }}</span>
                  <span class="s">现差 {{ gapInfo(detailMatch).gap }} · 需≥{{ gapInfo(detailMatch).minGap }}</span>
                </div>
                <template v-else>
                  <div class="kv">
                    <span class="k">现排名差</span>
                    <span class="v rank-curr">{{ gapInfo(detailMatch).gap }}</span>
                    <span class="s">{{ rankText(gapInfo(detailMatch).weakNow) }}−{{ rankText(gapInfo(detailMatch).strongNow) }} · {{ gapInfo(detailMatch).better }}高</span>
                  </div>
                  <div class="kv" v-if="gapInfo(detailMatch).rankDiff != null">
                    <span class="k">历史最高排名差</span>
                    <span class="v rank-best">{{ gapInfo(detailMatch).rankDiff }}</span>
                    <span class="s">{{ rankText(gapInfo(detailMatch).bestHigh) }}−{{ rankText(gapInfo(detailMatch).bestLow) }}</span>
                  </div>
                  <div class="kv" v-else>
                    <span class="k">历史最高排名差</span>
                    <span class="v muted">—</span>
                    <span class="s">缺最高排名</span>
                  </div>
                </template>
              </template>
              <div class="kv" v-else>
                <span class="k">现排名差</span>
                <span class="v muted">—</span>
                <span class="s">暂无现排名</span>
              </div>

              <template v-if="eloOf(detailMatch.id)?.ok">
                <div class="kv wide">
                  <span class="k">Elo</span>
                  <span class="v">
                    <template v-if="eloOf(detailMatch.id).best?.edge_pct == null">
                      {{ eloOf(detailMatch.id).best?.short || '—' }} {{ eloOf(detailMatch.id).best?.win_pct ?? '—' }}%
                    </template>
                    <template v-else>
                      {{ eloOf(detailMatch.id).best?.short || '—' }}
                      <span :class="eloOf(detailMatch.id).best.edge_pct >= 0 ? 'pos' : 'neg'">{{ fmtEdge(eloOf(detailMatch.id).best.edge_pct) }}</span>
                    </template>
                  </span>
                  <span class="s">
                    {{ eloOf(detailMatch.id).home?.short || '主' }} {{ eloOf(detailMatch.id).home?.win_pct ?? '—' }}%
                    <span :class="(eloOf(detailMatch.id).home?.edge_pct ?? 0) >= 0 ? 'pos' : 'neg'">{{ fmtEdge(eloOf(detailMatch.id).home?.edge_pct) }}</span>
                    ·
                    {{ eloOf(detailMatch.id).away?.short || '客' }} {{ eloOf(detailMatch.id).away?.win_pct ?? '—' }}%
                    <span :class="(eloOf(detailMatch.id).away?.edge_pct ?? 0) >= 0 ? 'pos' : 'neg'">{{ fmtEdge(eloOf(detailMatch.id).away?.edge_pct) }}</span>
                    · {{ eloOf(detailMatch.id).ratingSource || eloOf(detailMatch.id).surface || 'elo' }}
                  </span>
                </div>
              </template>
              <div class="kv wide" v-else>
                <span class="k">Elo</span>
                <span class="v muted">—</span>
                <span class="s">未匹配 Tennis Abstract</span>
              </div>

              <div class="kv" v-if="oddsOf(detailMatch.id)?.full_time">
                <span class="k">报价</span>
                <div class="kv-lines">
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchHomeName(detailMatch)) }}</span>
                    <span class="num">{{ fmtOdds(oddsOf(detailMatch.id).full_time.home) }}</span>
                  </div>
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchAwayName(detailMatch)) }}</span>
                    <span class="num">{{ fmtOdds(oddsOf(detailMatch.id).full_time.away) }}</span>
                  </div>
                </div>
                <span v-if="oddsSourceLabel(detailMatch.id)" class="s">{{ oddsSourceLabel(detailMatch.id) }}</span>
              </div>

              <div class="kv" v-if="polyOf(detailMatch.id)?.url">
                <span class="k">外链</span>
                <div class="kv-lines">
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchHomeName(detailMatch)) }}</span>
                    <span class="num">{{ polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).home == null ? '—' : polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).home }}</span>
                  </div>
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchAwayName(detailMatch)) }}</span>
                    <span class="num">{{ polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).away == null ? '—' : polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).away }}</span>
                  </div>
                </div>
                <span class="s">{{ polyOf(detailMatch.id)?.closed ? '已结算 · 隐含占比' : '隐含占比' }}</span>
              </div>
            </div>
          </div>

          <div class="modal-foot">
            <button type="button" class="act-btn" @click="closeDetail">关闭</button>
            <button
              type="button"
              class="act-btn market"
              :disabled="!polyUrlOf(detailMatch)"
              @click="openMarket(detailMatch)"
            >外链</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.wrap {
  --bg: #f8fafc;
  --card: #ffffff;
  --card-2: #f1f5f9;
  --line: #e2e8f0;
  --text: #1e293b;
  --muted: #94a3b8;
  --primary: #4f46e5;
  --primary-soft: #eef2ff;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  --pink: #db2777;
  color: var(--text);
  background: var(--bg);
  padding: 6px;
  border-radius: 0;
}
.topbar {
  display: flex; flex-wrap: nowrap; align-items: center; gap: 4px;
  margin-bottom: 6px; overflow-x: auto;
}
.meta-chip, .btn, .chip-btn, .filters button {
  border: 1px solid var(--line);
  background: var(--card);
  color: #64748b;
  border-radius: 999px;
  padding: 5px 11px;
  font-size: 0.78rem;
  font-weight: 600;
  flex-shrink: 0;
  line-height: 1.3;
}
.btn.ghost {
  cursor: pointer;
  color: var(--primary);
  border-color: #c7d2fe;
  background: var(--primary-soft);
  padding: 6px 12px;
  font-size: 0.82rem;
}
.btn:disabled { opacity: 0.5; cursor: wait; }
.stats {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px;
  margin: 0 0 0 auto; min-width: 168px; flex: 1; max-width: 260px;
}
.stat {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 3px;
  text-align: center;
}
.stat b {
  display: block;
  color: var(--primary);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}
.stat span { color: var(--muted); font-size: 0.52rem; line-height: 1.1; }
.stat-btn {
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
  font: inherit;
  width: 100%;
  padding: 2px 2px;
}
.stat-btn:hover {
  border-color: #c7d2fe;
  background: var(--primary-soft);
}
.stat-btn.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  box-shadow: 0 0 0 1px rgba(79, 70, 229, 0.25);
}
.stat-btn.active span { color: #6366f1; font-weight: 600; }
.filters { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.filter-panel {
  margin-bottom: 6px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.filter-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.filter-toggle-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.filter-toggle-title {
  font-size: 0.8rem;
  font-weight: 700;
  color: #0f172a;
}
.filter-toggle-summary {
  font-size: 0.7rem;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.filter-toggle-arrow {
  color: var(--primary);
  font-size: 0.86rem;
  line-height: 1;
  transition: transform 0.18s ease;
  flex-shrink: 0;
}
.filter-toggle-arrow.open { transform: rotate(180deg); }
.filter-body {
  padding: 0 8px 8px;
  border-top: 1px solid #f1f5f9;
  padding-top: 8px;
}
.filter-row {
  display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
  margin-bottom: 6px;
}
.filter-row:last-child { margin-bottom: 0; }
.filter-row .label {
  color: #64748b; font-size: 0.72rem; font-weight: 600; min-width: 2rem;
}
.range-rules-text {
  flex: 1;
  font-size: 0.72rem;
  line-height: 1.35;
  color: #475569;
  font-weight: 600;
}
.inplay-source-bar {
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: 0.72rem;
  line-height: 1.4;
}
.settled-stats-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #334155;
  font-size: 0.72rem;
  line-height: 1.4;
}
.settled-rule-stat {
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid #e2e8f0;
  color: #0f172a;
}
.settled-rule-stat em {
  font-style: normal;
  margin-left: 4px;
  color: #94a3b8;
  font-size: 0.65rem;
}
.settled-rule-hint {
  color: #94a3b8;
}
.inplay-source-bar code {
  font-size: 0.7rem;
  background: #fef3c7;
  padding: 1px 4px;
  border-radius: 4px;
}
.empty.inplay-empty {
  border-color: #fed7aa;
  background: #fff7ed;
  color: #9a3412;
}
.empty.inplay-empty .inplay-empty-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-weight: 700;
  font-size: 0.92rem;
}
.empty.inplay-empty .bang {
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 0.85rem;
  line-height: 1;
  color: #fff;
  background: #ea580c;
}
.empty.inplay-empty .hint {
  margin-top: 8px;
  color: #9a3412;
  opacity: 0.95;
  font-size: 0.74rem;
  line-height: 1.45;
  max-width: 28rem;
  margin-left: auto;
  margin-right: auto;
}
.new-pool-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}
.new-pool-bar .label {
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 600;
  min-width: 2.5rem;
}
.new-pool-hint {
  flex: 1 1 160px;
  font-size: 0.68rem;
  color: #94a3b8;
  line-height: 1.35;
}
.live-tier-rules {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.live-tier-rule {
  font-size: 10px;
  font-weight: 700;
  color: #64748b;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 999px;
  padding: 2px 8px;
}
.live-tier-rule.on {
  color: #6d28d9;
  border-color: #ddd6fe;
  background: #f5f3ff;
}
.live-gap-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: #475569;
  margin: 2px 0 4px;
  padding: 0 2px;
}
.live-gap-strip b { color: #b45309; font-weight: 800; }
.live-gap-strip .muted { color: #94a3b8; font-weight: 600; }
.badge.live-tier { background: #f5f3ff; color: #6d28d9; border: 1px solid #ddd6fe; }
.badge.live-tier.ok { background: #ecfdf5; color: #047857; border-color: #bbf7d0; }
.badge.live-tier.warn { background: #fff7ed; color: #c2410c; border-color: #fed7aa; }
.live-only-label {
  font-size: 0.82rem;
  color: #7c3aed;
  font-weight: 600;
}
.chip-btn, .filters button { cursor: pointer; padding: 6px 12px; font-size: 0.82rem; }
.chip-btn.active, .filters button.active {
  color: var(--primary);
  background: var(--primary-soft);
  border-color: #c7d2fe;
  font-weight: 700;
}
.list { display: grid; gap: 5px; }
.row-card {
  background: var(--card);
  border: 1px solid #f1f5f9;
  border-radius: 10px;
  padding: 6px 8px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 6px;
}
.row-card.selected {
  border-color: #c7d2fe;
  background: #fafaff;
  box-shadow: 0 0 0 1px rgba(79, 70, 229, 0.12);
}
.row-check {
  flex-shrink: 0;
  padding-top: 2px;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
}
.row-check.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.row-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: inherit;
}
.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.batch-bar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  margin-bottom: 6px;
  padding: 6px 8px;
  background: var(--card);
  border: 1px solid #c7d2fe;
  border-radius: 8px;
}
.batch-bar-controls {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
}
.auto-bet-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  font-weight: 700;
  color: #64748b;
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 999px;
  padding: 4px 8px;
  cursor: pointer;
  flex-shrink: 0;
}
.auto-bet-toggle.on {
  color: #14532d;
  border-color: #86efac;
  background: #f0fdf4;
}
.auto-bet-toggle input {
  accent-color: #16a34a;
}
.batch-check-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.74rem;
  font-weight: 600;
  color: #475569;
  cursor: pointer;
  flex-shrink: 0;
}
.batch-check-all input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
}
.batch-count {
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--primary);
  flex-shrink: 0;
}
.batch-amount {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.74rem;
  font-weight: 600;
  color: #64748b;
  flex-shrink: 0;
}
.batch-amount input {
  width: 3.6rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 6px;
  font-size: 0.82rem;
  font-weight: 700;
  color: #0f172a;
}
.batch-btn {
  border: 0;
  background: var(--primary);
  color: #fff;
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
}
.batch-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.batch-clear {
  border: 1px solid var(--line);
  background: #fff;
  color: #64748b;
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}
.batch-notice,
.batch-error {
  display: block;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.4;
  white-space: pre-line;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 5.6em;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 2px 2px;
}
.batch-notice {
  color: var(--success);
  border-top: 1px dashed #bbf7d0;
}
.batch-error {
  color: var(--danger);
  border-top: 1px dashed #fecaca;
}
.row-time {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid #f1f5f9;
}
.row-time .start-value {
  color: #0f172a;
  font-size: 0.84rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.row-time .start-value.today {
  color: #dc2626;
}
.row-time .start-status {
  color: #64748b;
  font-size: 0.7rem;
  font-weight: 600;
}
.row-time .start-status.live {
  color: var(--success);
  font-weight: 700;
}
.row-time .tour-title {
  color: #64748b;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.3;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.matchup {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
  flex: 1;
}
.matchup.is-live-board,
.matchup.is-stacked {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.matchup-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.matchup.is-stacked .matchup-line {
  justify-content: flex-start;
}
.vs-row {
  color: var(--muted);
  font-size: 0.72rem;
  font-weight: 800;
  line-height: 1.1;
  padding: 1px 0;
  flex-shrink: 0;
}
.matchup.is-live-board .name {
  min-width: 0;
  flex: 1;
  text-align: left;
  justify-content: flex-start;
  padding: 0;
  margin: 0;
}
.matchup.is-live-board .live-player-top,
.matchup.is-live-board .live-player-bottom {
  width: auto;
  max-width: 100%;
}
.live-set-scores {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 0 2px;
  flex-shrink: 0;
}
.live-set-scores .set-cell {
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  min-width: 0.9rem;
  text-align: center;
}
.live-set-scores .score-big {
  color: #2563eb;
  font-size: 0.95rem;
  font-weight: 800;
}
.live-set-scores .score-small {
  color: #dc2626;
  font-size: 0.78rem;
  font-weight: 700;
}
.live-set-scores .score-even {
  color: #334155;
  font-size: 0.86rem;
  font-weight: 700;
}
.live-set-scores .live-point {
  margin-left: 2px;
  padding-left: 5px;
  border-left: 1px solid #e2e8f0;
  color: #0f172a;
  font-size: 0.82rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.matchup.is-stacked .name {
  min-width: 0;
  flex-wrap: wrap;
  white-space: normal;
}
.matchup.is-stacked .player-name {
  min-width: 0;
}
.matchup.is-live .player-row.live-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.matchup.is-live .player-row.live-line .name {
  flex: 1;
  min-width: 0;
}
.matchup .name .player-score,
.matchup .player-row .player-score {
  margin-left: 5px;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 800;
  color: #334155;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.matchup.is-live .player-row.live-line .player-score {
  margin-left: 0;
  text-align: right;
  white-space: nowrap;
}
.matchup .name {
  font-size: 0.96rem;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.matchup .name.pick { color: var(--primary); }
.list-rank {
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.pick-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 5px;
  font-size: 0.6rem;
  font-weight: 700;
  line-height: 1.35;
  color: #fff;
  background: var(--primary);
}
.matchup .vs-text {
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
  flex-shrink: 0;
}
.row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  align-items: center;
}
.act-btn {
  border: 1px solid #c7d2fe;
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: 8px;
  padding: 7px 11px;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.2;
}
.act-btn.market {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.act-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pager {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f5f9;
}
.pager-info {
  color: #64748b; font-size: 0.76rem; font-weight: 600;
  min-width: 5.5em; text-align: center;
}
.pager-btn {
  border: 1px solid var(--line);
  background: var(--card);
  color: #475569;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}
.pager-btn:hover:not(:disabled) {
  border-color: #c7d2fe;
  color: var(--primary);
  background: var(--primary-soft);
}
.pager-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.empty {
  text-align: center; color: var(--muted);
  padding: 16px 8px; font-size: 0.86rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.empty.err { color: var(--danger); }
.empty .hint { margin-top: 6px; font-size: 0.68rem; opacity: 0.85; }

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 8px;
}
.modal-sheet {
  width: 100%;
  max-width: 26rem;
  max-height: min(88vh, 720px);
  background: #fff;
  border-radius: 14px 14px 12px 12px;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid #f1f5f9;
}
.modal-head-main { min-width: 0; flex: 1; }
.modal-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.modal-title { font-size: 0.92rem; font-weight: 800; color: #0f172a; line-height: 1.2; }
.modal-sub { margin-top: 2px; font-size: 0.88rem; font-weight: 700; color: #334155; line-height: 1.3; }
.modal-meta {
  margin-top: 4px; font-size: 0.72rem; color: #64748b; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.modal-meta .today { color: #dc2626; font-weight: 700; }
.modal-badges { margin-top: 6px; justify-content: flex-start; }
.modal-x {
  width: 32px; height: 32px; border: 1px solid var(--line);
  background: #fff; color: #64748b; border-radius: 8px;
  font-size: 1.25rem; line-height: 1; cursor: pointer; flex-shrink: 0;
}
.modal-body {
  padding: 10px 12px 12px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.modal-foot {
  display: flex;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px solid #f1f5f9;
}
.modal-foot .act-btn {
  flex: 1;
  padding: 10px 10px;
  font-size: 0.86rem;
  border-radius: 8px;
}

.duel {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 6px;
  align-items: stretch;
  margin-bottom: 10px;
}
.duel-vs {
  align-self: center;
  font-size: 0.72rem;
  font-weight: 800;
  color: var(--muted);
}
.duel-side {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px 9px;
  min-width: 0;
}
.duel-side.pick {
  border-color: #c7d2fe;
  background: var(--primary-soft);
}
.duel-top {
  display: flex; align-items: center; justify-content: space-between; gap: 4px;
}
.duel-rank {
  font-size: 0.82rem; font-weight: 800; color: #2563eb;
  font-variant-numeric: tabular-nums;
}
.duel-score {
  font-size: 0.8rem; font-weight: 800; color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.duel-name {
  margin-top: 3px;
  font-size: 0.88rem; font-weight: 800; color: #0f172a;
  line-height: 1.25;
  word-break: break-word;
}
.duel-side.pick .duel-name { color: #3730a3; }
.duel-sub {
  margin-top: 3px;
  font-size: 0.68rem; color: #64748b; line-height: 1.35;
}
.duel-sub .rank-best {
  color: #dc2626;
  font-weight: 700;
}

.kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.kv {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 7px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kv.wide { grid-column: 1 / -1; }
.kv .k {
  font-size: 0.68rem; font-weight: 700; color: #94a3b8;
  text-transform: uppercase; letter-spacing: 0.02em;
}
.kv .v {
  font-size: 0.86rem; font-weight: 800; color: #0f172a;
  font-variant-numeric: tabular-nums; line-height: 1.3;
  word-break: break-word;
}
.kv .v.warn { color: var(--warning); }
.kv .v.rank-curr { color: #2563eb; }
.kv .v.rank-best { color: #dc2626; }
.kv .v.muted, .kv .s { color: #64748b; }
.kv .s { font-size: 0.68rem; line-height: 1.35; font-weight: 600; }
.kv-lines { display: grid; gap: 3px; margin-top: 1px; }
.kv-line {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-variant-numeric: tabular-nums;
}
.kv-line .n {
  font-size: 0.82rem; font-weight: 700; color: #334155;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.kv-line .num {
  font-size: 0.88rem; font-weight: 800; color: #0f172a; flex-shrink: 0;
}
.pos { color: var(--success); }
.neg { color: var(--danger); }

.badges { display: flex; flex-wrap: wrap; gap: 4px; }
.badge {
  border-radius: 999px; padding: 3px 8px;
  font-size: 0.76rem; font-weight: 700; line-height: 1.35;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge.gender-m { background: #eef2ff; color: #4338ca; }
.badge.gender-f { background: #fdf2f8; color: #be185d; }
.badge.level { background: #f0fdf4; color: #15803d; }
.badge.odds { background: #fffbeb; color: #b45309; }
.badge.poly { background: #f5f3ff; color: #6d28d9; }
.badge.pnl-win { background: #ecfdf5; color: #047857; }
.badge.pnl-loss { background: #fef2f2; color: #b91c1c; }
.badge.pnl-flat { background: #f8fafc; color: #64748b; }
.badge.pnl-bet { background: #eff6ff; color: #1d4ed8; }
.badge.pick { background: var(--primary); color: #fff; }
.help-bang.modal-help-bang {
  width: 32px;
  height: 32px;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  background: #fff7ed;
  color: #c2410c;
  font-size: 1rem;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.help-bang.modal-help-bang.on {
  background: #ea580c;
  border-color: #ea580c;
  color: #fff;
}
.modal-help-panel {
  margin: 0;
  padding: 10px 12px;
  border-bottom: 1px solid #fed7aa;
  background: #fff7ed;
  color: #9a3412;
  max-height: 40vh;
  overflow-y: auto;
}
.modal-help-title {
  font-size: 0.8rem;
  font-weight: 800;
  margin-bottom: 6px;
}
.modal-help-list {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.72rem;
  line-height: 1.5;
  font-weight: 600;
}
.modal-help-list li { margin-bottom: 4px; }
.modal-help-list b { color: #7c2d12; }
.tour-title { color: #64748b; font-size: 0.72rem; font-weight: 600; }
.pname.pick { color: var(--primary); font-weight: 700; }
.pname .pick-tag { margin-left: 4px; vertical-align: middle; }
</style>
