<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as api from '../api'
import { passesRangeTennis, passesTopPool, matchRangeMetrics, tierLabel, RANGE_RULES_TEXT, NEW_POOL_RULES_TEXT } from '../utils/tennisRangeFilter'
const props = defineProps({
  showFilters: { type: Boolean, default: false },
  /** 有效订阅内可见排名/推荐/详情/外链 */
  isMember: { type: Boolean, default: false },
  /** 已配置钱包且开通 BTC 虚拟投注时可批量下单 */
  canBatchTrade: { type: Boolean, default: false },
  /** classic=原 Top20 网球；range=区间网球；live=ATP·WTA 盘中 Top100；new=新网球列表 Top100 池 */
  boardMode: { type: String, default: 'classic' },
})

const isRangeMode = computed(() => props.boardMode === 'range')
const isLiveMode = computed(() => props.boardMode === 'live')
const isNewMode = computed(() => props.boardMode === 'new')
const apiPath = computed(() => {
  if (isRangeMode.value) return '/api/tennis-range'
  if (isLiveMode.value) return '/api/tennis-live'
  if (isNewMode.value) return '/api/tennis-new'
  return '/api/tennis'
})
const PAGE_SIZE = 5
const data = ref(null)
const loading = ref(true)
const error = ref('')
const filter = ref('Not started') // all | Not started | liveish | ended
const tour = ref('all') // all | ATP | WTA
const gapMin = ref('50') // all | 50 | 70 | 90
const diffMax = ref('0') // all | 0 | -30 | -50 | -70
const strongRankMax = ref('20') // all | 10 | 20
const topPoolMax = ref('100') // 10 | 20 | 50 | 100（新网球列表）
const filtersOpen = ref(false)
const detailMatch = ref(null)
const selectedIds = ref(new Set())
const batchAmountUsd = ref('1')
const batchSubmitting = ref(false)
const batchNotice = ref('')
const batchError = ref('')
const AUTO_BET_KEY = computed(() => {
  if (isRangeMode.value) return 'yuce.tennisRange.autoBet.v1'
  if (isLiveMode.value) return 'yuce.tennisLive.autoBet.v1'
  if (isNewMode.value) return 'yuce.tennisNew.autoBet.v1'
  return 'yuce.tennis.autoBet.v1'
})
const AUTO_PLACED_KEY = computed(() => {
  if (isRangeMode.value) return 'yuce.tennisRange.autoPlaced.v1'
  if (isLiveMode.value) return 'yuce.tennisLive.autoPlaced.v1'
  if (isNewMode.value) return 'yuce.tennisNew.autoPlaced.v1'
  return 'yuce.tennis.autoPlaced.v1'
})
const autoBetEnabled = ref(false)
const autoPlacedIds = ref(new Set())

function loadTennisAutoState() {
  try {
    autoBetEnabled.value = localStorage.getItem(AUTO_BET_KEY.value) === '1'
    const raw = JSON.parse(localStorage.getItem(AUTO_PLACED_KEY.value) || '[]')
    autoPlacedIds.value = new Set(Array.isArray(raw) ? raw.map(String) : [])
  } catch {
    autoBetEnabled.value = false
    autoPlacedIds.value = new Set()
  }
}

function saveTennisAutoState() {
  localStorage.setItem(AUTO_BET_KEY.value, autoBetEnabled.value ? '1' : '0')
  localStorage.setItem(AUTO_PLACED_KEY.value, JSON.stringify([...autoPlacedIds.value].slice(-200)))
}

async function toggleAutoBet(ev) {
  const want = !!ev?.target?.checked
  if (want && !props.canBatchTrade) {
    batchError.value = '当前账号未开通网球自动投注'
    ev.target.checked = false
    return
  }
  if (want && !window.confirm('确认开启网球自动投注？\n将对可同步场次按当前金额自动批量确认，风险自负。')) {
    ev.target.checked = false
    return
  }
  autoBetEnabled.value = want
  saveTennisAutoState()
  batchNotice.value = want ? '已开启自动投注' : '已关闭自动投注'
  if (want) await maybeAutoBatchTrade()
}
const serverTimeBase = ref(null)
const loadedAtMs = ref(null)
const clockTick = ref(0)
let tickTimer = null
let refreshTimer = null

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

function rankDetailOf(player) {
  const id = player?.id ?? player?.teamId
  const map = data.value?.rankingsByPlayer || {}
  const fromMap = id != null ? map[String(id)] || map[id] : null
  return {
    current: fromMap?.current ?? player?.ranking ?? player?.currentRank ?? null,
    previous: fromMap?.previous ?? null,
    best: fromMap?.best ?? null,
    live: fromMap?.live ?? null,
    utr: fromMap?.utr ?? null,
  }
}

function currentRankOf(player) {
  return rankDetailOf(player).current
}

function playerNameWithAge(player, eloSide) {
  const name = player?.name || '—'
  const year = new Date().getFullYear()
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
  if (player?.birthYear != null && player.birthYear !== '') age = year - Number(player.birthYear)
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
  const gap = Math.abs(homeR - awayR)
  const homeStronger = homeR < awayR
  const strongNow = homeStronger ? homeR : awayR
  const homeDetail = rankDetailOf(home)
  const awayDetail = rankDetailOf(away)
  const weakBest = homeStronger ? awayDetail.best : homeDetail.best
  const hasRankDiff = weakBest != null
  const rankDiff = hasRankDiff ? strongNow - Number(weakBest) : 0
  return { gap, rankDiff, ready: true, hasRankDiff, strongRank: strongNow }
}

function matchPassesTour(m) {
  if (tour.value === 'all') return true
  const t = (m.tour || ((m.gender || m.homePlayer?.gender || m.awayPlayer?.gender) === 'F' ? 'WTA' : 'ATP')).toUpperCase()
  return t === tour.value
}

/** 排名/现差筛选（仅用于未开始、全部；未订阅不按排名筛） */
function matchPassesRank(m) {
  if (!matchPassesTour(m)) return false
  if (!props.isMember) return true
  if (isRangeMode.value) {
    return passesRangeTennis(m, data.value?.rankingsByPlayer || {})
  }
  if (isNewMode.value) {
    return passesTopPool(m, topPoolMax.value, data.value?.rankingsByPlayer || {})
  }
  const metrics = matchMetrics(m)
  if (gapMin.value !== 'all') {
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

function matchPassesFilter(m, statusFilter) {
  const mode = STATUS_TABS.has(statusFilter) ? statusFilter : filter.value
  if (!matchPassesTour(m)) return false
  if (!isRangeMode.value && !polyUrlOf(m)) return false
  if (isMatchEnded(m) && mode === 'liveish') return false
  if (mode === 'liveish') {
    // 进行中列表：不过排名筛选（live 常无排名）
    return isMatchLive(m)
  }
  if (mode === 'ended') {
    // 已结束：不过排名筛选
    return isMatchEnded(m)
  }
  if (mode === 'Not started') {
    if (!isMatchNotStarted(m)) return false
    return matchPassesRank(m)
  }
  // 全部：进行中/已结束不过排名，其余走排名筛选
  if (isMatchLive(m) || isMatchEnded(m)) return true
  return matchPassesRank(m)
}

function allMatches(bundle) {
  if (!bundle) return []
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
  // 先赛程后 live：同 id 时保留 live 的状态/比分
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

function canSelectMatch(m) {
  if (!props.isMember || !props.canBatchTrade) return false
  if (!m?.id || isMatchEnded(m)) return false
  if (!polyUrlOf(m)) return false
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
    const resp = isRangeMode.value
      ? await api.placeTennisRangeBatchTrade({ orders, amountUsd: amount })
      : isLiveMode.value
        ? await api.placeTennisLiveBatchTrade({ orders, amountUsd: amount })
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
  if (!autoBetEnabled.value || !props.canBatchTrade || batchSubmitting.value) return
  const candidates = matches.value.filter((m) => canSelectMatch(m) && !autoPlacedIds.value.has(String(m.id)))
  if (!candidates.length) return
  const next = new Set(selectedIds.value)
  for (const m of candidates) next.add(String(m.id))
  selectedIds.value = next
  await submitBatchTrade({ auto: true })
}

watch([filter, tour, gapMin, diffMax, strongRankMax, topPoolMax], () => {
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
  if (filter.value === mode) return
  filter.value = mode
  currentPage.value = 1
}

const stats = computed(() => {
  const pool = rawMatches.value.filter((m) => {
    if (!matchPassesTour(m)) return false
    if (!isRangeMode.value && !polyUrlOf(m)) return false
    return true
  })
  const countTab = (tab) => pool.filter((m) => matchPassesFilter(m, tab)).length
  return {
    date: data.value?.date || '—',
    tournaments: data.value?.scheduled?.tournamentCount ?? 0,
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
  if (props.isMember) {
    if (isRangeMode.value) parts.push(RANGE_RULES_TEXT)
    else if (isNewMode.value) parts.push(`Top${topPoolMax.value}`)
    else {
      if (gapMin.value !== 'all') parts.push(`现差≥${gapMin.value}`)
      if (diffMax.value !== 'all') parts.push(`排位差≤${diffMax.value}`)
      if (strongRankMax.value !== 'all') parts.push(`强者现≤${strongRankMax.value}`)
    }
  }
  return parts.join(' · ')
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
  return polyOf(m?.id)?.url || ''
}
function openDetail(m) {
  if (!props.isMember) return
  detailMatch.value = m
}
function closeDetail() {
  detailMatch.value = null
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

/** 从 Redis 加载；silent 时不打断列表（用于后台轮询完赛/比分） */
async function loadOnce({ silent = false } = {}) {
  error.value = ''
  if (!silent) loading.value = true
  try {
    const token = localStorage.getItem('token') || ''
    const res = await fetch(`${apiPath.value}/today`, {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const bundle =
      payload?.scheduled || payload?.rankingsByPlayer
        ? payload
        : payload?.data || payload
    data.value = bundle
    if (bundle?.serverTime != null) {
      serverTimeBase.value = Number(bundle.serverTime)
      loadedAtMs.value = Date.now()
    }
    await maybeAutoBatchTrade()
  } catch (e) {
    if (!silent) error.value = e?.message || '加载失败'
  } finally {
    if (!silent) loading.value = false
  }
}

onMounted(() => {
  loadTennisAutoState()
  loadOnce()
  tickTimer = setInterval(() => { clockTick.value++ }, 30000)
  const refreshMs = isLiveMode.value ? 120000 : 60000
  refreshTimer = setInterval(() => { loadOnce({ silent: true }) }, refreshMs)
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (refreshTimer) clearInterval(refreshTimer)
})

function gapInfo(m) {
  if (isRangeMode.value) {
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
  const homeDetail = rankDetailOf(home)
  const awayDetail = rankDetailOf(away)
  if (homeR == null || awayR == null) return { ready: false }
  const gap = Math.abs(homeR - awayR)
  const homeStronger = homeR < awayR
  const better = homeStronger ? shortName(home.name) : shortName(away.name)
  const strongNow = homeStronger ? homeR : awayR
  const weakBest = homeStronger ? awayDetail.best : homeDetail.best
  let rankDiff = null
  if (weakBest != null) rankDiff = strongNow - Number(weakBest)
  return {
    ready: true,
    gap,
    homeR,
    awayR,
    better,
    strongNow,
    weakBest,
    rankDiff,
  }
}
</script>

<template>
  <div class="wrap">
    <div class="topbar">
      <span class="meta-chip">{{ stats.date }}</span>
      <span class="meta-chip">{{ loading ? '…' : `${stats.shown}/${stats.all}` }}</span>
      <div class="stats">
        <div class="stat"><b>{{ stats.tournaments }}</b><span>赛</span></div>
        <button type="button" class="stat stat-btn" :class="{ active: filter === 'all' }" @click="setStatusFilter('all')">
          <b>{{ stats.all }}</b><span>全</span>
        </button>
        <button type="button" class="stat stat-btn" :class="{ active: filter === 'Not started' }" @click="setStatusFilter('Not started')">
          <b>{{ stats.open }}</b><span>未开</span>
        </button>
        <button type="button" class="stat stat-btn" :class="{ active: filter === 'liveish' }" @click="setStatusFilter('liveish')">
          <b>{{ stats.live }}</b><span>进行</span>
        </button>
        <button type="button" class="stat stat-btn" :class="{ active: filter === 'ended' }" @click="setStatusFilter('ended')">
          <b>{{ stats.ended }}</b><span>结束</span>
        </button>
      </div>
    </div>

    <div v-if="showFilters" class="filter-panel">
      <button type="button" class="filter-toggle" @click="filtersOpen = !filtersOpen">
        <span class="filter-toggle-main">
          <span class="filter-toggle-title">筛选</span>
          <span class="filter-toggle-summary">{{ filterSummary }}</span>
        </span>
        <span class="filter-toggle-arrow" :class="{ open: filtersOpen }">▾</span>
      </button>

      <div v-show="filtersOpen" class="filter-body">
        <div class="filters">
          <button type="button" :class="{ active: filter === 'all' }" @click="setStatusFilter('all')">全部</button>
          <button type="button" :class="{ active: filter === 'Not started' }" @click="setStatusFilter('Not started')">未开始</button>
          <button type="button" :class="{ active: filter === 'liveish' }" @click="setStatusFilter('liveish')">进行中</button>
          <button type="button" :class="{ active: filter === 'ended' }" @click="setStatusFilter('ended')">已结束</button>
        </div>

        <div class="filter-row">
          <span class="label">巡回</span>
          <button type="button" class="chip-btn" :class="{ active: tour === 'all' }" @click="tour = 'all'">全部</button>
          <button type="button" class="chip-btn" :class="{ active: tour === 'ATP' }" @click="tour = 'ATP'">男</button>
          <button type="button" class="chip-btn" :class="{ active: tour === 'WTA' }" @click="tour = 'WTA'">女</button>
        </div>

        <template v-if="isMember && !isRangeMode && !isNewMode">
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
          </div>
        </template>
        <div v-else-if="isMember && isRangeMode" class="filter-row range-rules">
          <span class="label">区间</span>
          <span class="range-rules-text">{{ RANGE_RULES_TEXT }}</span>
        </div>
        <div v-else-if="isMember && isNewMode" class="filter-row">
          <span class="label">排名池</span>
          <button type="button" class="chip-btn" :class="{ active: topPoolMax === '10' }" @click="topPoolMax = '10'">Top10</button>
          <button type="button" class="chip-btn" :class="{ active: topPoolMax === '20' }" @click="topPoolMax = '20'">Top20</button>
          <button type="button" class="chip-btn" :class="{ active: topPoolMax === '50' }" @click="topPoolMax = '50'">Top50</button>
          <button type="button" class="chip-btn" :class="{ active: topPoolMax === '100' }" @click="topPoolMax = '100'">Top100</button>
        </div>
        <div v-if="isMember && isNewMode" class="filter-row range-rules">
          <span class="label">规则</span>
          <span class="range-rules-text">{{ NEW_POOL_RULES_TEXT }}</span>
        </div>
      </div>
    </div>

    <div v-if="loading && !data" class="empty">加载赛程中…</div>
    <div v-else-if="error && !data" class="empty err">{{ error }}</div>
    <div v-else-if="!matches.length" class="empty">
      当前筛选下没有场次（池内 {{ stats.total }} 场 · 符合筛选 {{ stats.shown }} 场）
      <div v-if="data?.message" class="hint">{{ data.message }}</div>
      <div v-else-if="data?.update?.message" class="hint">{{ data.update.message }}</div>
    </div>

    <template v-else>
    <div v-if="canBatchTrade" class="batch-bar">
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
        <label v-if="canBatchTrade" class="row-check" :class="{ disabled: !canSelectMatch(m) }">
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
          </div>
        </div>
        <div class="row-main">
          <div class="matchup is-stacked" :class="{ 'is-live': isMatchLive(m) }">
            <div class="player-row" :class="{ 'live-line': isMatchLive(m) }">
              <span class="name" :class="{ pick: isMember && pickSide(m) === 'home', 'live-side': isMatchLive(m) }">
                <span v-if="isMember && listRankOf(m, 'home') != null" class="list-rank">#{{ listRankOf(m, 'home') }}</span>
                <span class="player-name">{{ matchHomeName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'home'" class="pick-tag">优</span>
              </span>
              <span v-if="isMatchLive(m) && playerLiveScoreText(m, 'home')" class="player-score">{{ playerLiveScoreText(m, 'home') }}</span>
            </div>
            <span class="vs-text vs-mid">VS</span>
            <div class="player-row" :class="{ 'live-line': isMatchLive(m) }">
              <span class="name" :class="{ pick: isMember && pickSide(m) === 'away', 'live-side': isMatchLive(m) }">
                <span v-if="isMember && listRankOf(m, 'away') != null" class="list-rank">#{{ listRankOf(m, 'away') }}</span>
                <span class="player-name">{{ matchAwayName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'away'" class="pick-tag">优</span>
              </span>
              <span v-if="isMatchLive(m) && playerLiveScoreText(m, 'away')" class="player-score">{{ playerLiveScoreText(m, 'away') }}</span>
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
                <span v-if="pickSide(detailMatch)" class="badge pick">优{{ pickSide(detailMatch) === 'home' ? shortName(matchHomeName(detailMatch)) : shortName(matchAwayName(detailMatch)) }}</span>
              </div>
            </div>
            <button type="button" class="modal-x" @click="closeDetail" aria-label="关闭">×</button>
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
                  周{{ rankText(rankDetailOf(detailMatch.homePlayer || {}).previous) }}
                  · 高{{ rankText(rankDetailOf(detailMatch.homePlayer || {}).best) }}
                  · L{{ rankText(rankDetailOf(detailMatch.homePlayer || {}).live) }}
                  · U{{ rankText(rankDetailOf(detailMatch.homePlayer || {}).utr) }}
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
                  周{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}).previous) }}
                  · 高{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}).best) }}
                  · L{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}).live) }}
                  · U{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}).utr) }}
                </div>
              </div>
            </div>

            <div class="kv-grid">
              <template v-if="gapInfo(detailMatch).ready">
                <div class="kv">
                  <span class="k">现差</span>
                  <span class="v warn">{{ gapInfo(detailMatch).gap }}</span>
                  <span class="s">{{ rankText(gapInfo(detailMatch).homeR) }}/{{ rankText(gapInfo(detailMatch).awayR) }} · {{ gapInfo(detailMatch).better }}高</span>
                </div>
                <div class="kv" v-if="gapInfo(detailMatch).rankDiff != null">
                  <span class="k">排差</span>
                  <span class="v warn">{{ gapInfo(detailMatch).rankDiff > 0 ? '+' : '' }}{{ gapInfo(detailMatch).rankDiff }}</span>
                  <span class="s">强{{ rankText(gapInfo(detailMatch).strongNow) }}−弱高{{ rankText(gapInfo(detailMatch).weakBest) }}</span>
                </div>
                <div class="kv" v-else>
                  <span class="k">排差</span>
                  <span class="v muted">—</span>
                  <span class="s">缺最高排名</span>
                </div>
              </template>
              <div class="kv" v-else>
                <span class="k">现差</span>
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
                <span class="s">{{ oddsOf(detailMatch.id).source || oddsOf(detailMatch.id).full_time?.source || '—' }}</span>
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
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px;
  margin: 0 0 0 auto; min-width: 148px; flex: 1; max-width: 220px;
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
.matchup.is-stacked {
  flex-direction: column;
  align-items: stretch;
  flex-wrap: nowrap;
  gap: 2px;
}
.player-row {
  display: flex;
  align-items: center;
  min-width: 0;
}
.matchup.is-stacked .name {
  min-width: 0;
  flex-wrap: wrap;
  white-space: normal;
}
.matchup.is-stacked .player-name {
  min-width: 0;
}
.matchup.is-stacked .vs-mid {
  align-self: center;
  margin: 1px 0;
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
  font-size: 0.82rem; font-weight: 800; color: var(--primary);
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
}
.badge.gender-m { background: #eef2ff; color: #4338ca; }
.badge.gender-f { background: #fdf2f8; color: #be185d; }
.badge.level { background: #f0fdf4; color: #15803d; }
.badge.odds { background: #fffbeb; color: #b45309; }
.badge.poly { background: #f5f3ff; color: #6d28d9; }
.badge.pick { background: var(--primary); color: #fff; }
.tour-title { color: #64748b; font-size: 0.72rem; font-weight: 600; }
.pname.pick { color: var(--primary); font-weight: 700; }
.pname .pick-tag { margin-left: 4px; vertical-align: middle; }
</style>
