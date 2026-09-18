<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as api from '../api'
import { sofaTennisMatchUrl } from '../utils/sofaMatchUrl'

const props = defineProps({
  /** collect | condition | betting | stop — 管理中心独立页面 */
  enginePage: {
    type: String,
    default: 'collect',
    validator: (v) => ['collect', 'condition', 'betting', 'stop'].includes(v),
  },
})

const emit = defineEmits(['open-docks-editor', 'open-top100-wide'])

const isCollectPage = computed(() => props.enginePage === 'collect')
const isConditionPage = computed(() => props.enginePage === 'condition')
const isBettingPage = computed(() => props.enginePage === 'betting')
const isStopPage = computed(() => props.enginePage === 'stop')
/** 投注与止损共用 betting 配置草稿 */
const isBettingOrStopPage = computed(() => isBettingPage.value || isStopPage.value)
/** 条件/投注/止损：只改规则，不拉采集 status / top100 / live 等 */
const isConfigOnlyPage = computed(
  () => isConditionPage.value || isBettingPage.value || isStopPage.value,
)
/** 采集页全屏 loading；条件/投注/止损页仅引擎区异步加载 */
const pageBlockingLoading = computed(() => !isConfigOnlyPage.value && loading.value)

const pageTitle = computed(() => {
  if (isConditionPage.value) return '条件引擎'
  if (isBettingPage.value) return '投注引擎'
  if (isStopPage.value) return '止损引擎'
  return '采集引擎'
})

const conditionTab = ref('prematch')
const CONDITION_TABS = [
  { id: 'prematch', label: '盘前' },
  { id: 'inplay', label: '盘中' },
  { id: 'settled', label: '盘后' },
]

const bettingTab = ref('inplay')
const BETTING_TABS = [
  { id: 'prematch', label: '盘前' },
  { id: 'inplay', label: '盘中' },
]

function emptyConditionGroup() {
  return {
    id: `cg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    joinPrev: 'or',
    linkPrematch: false,
    tour: 'all',
    pm: 'all',
    gapMin: 'all',
    rankDiffMin: 'all',
    rankDiffMax: 'all',
    strongRankMax: 'all',
    strongRankGt: 'all',
    strongRankLt: 'all',
    gapMode: 'all',
    requireWonFirstSet: false,
    firstSetExcludeEnabled: false,
    firstSetExcludeScore: '7:5',
  }
}

function emptyBettingGroup(kind = 'inplay') {
  const isInplay = kind === 'inplay'
  const id = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    strategyKey: id,
    name: '',
    joinPrev: 'or',
    amountUsd: 1,
    stopEnabled: isInplay,
    stopRules: isInplay ? [emptyStopRule()] : [],
  }
}

function emptyStopRule() {
  return {
    name: '',
    joinPrev: 'or',
    stopFormat: 'any',
    stopSetIndex: 'all',
    stopStrongSets: 'all',
    stopWeakSets: 'all',
    stopGameLead: 'all',
    stopWeakGamesMin: 'all',
    stopPmCentsMax: 'all',
  }
}

function groupDisplayName(g, index) {
  const n = String(g?.name || '').trim()
  return n || `条件组 ${index + 1}`
}

function stopRuleDisplayName(r, index) {
  const n = String(r?.name || '').trim()
  return n || `止损 ${index + 1}`
}

function ensureStopRules(g) {
  // 显式空数组表示无止损，不要回填默认条
  if (Array.isArray(g?.stopRules)) return g.stopRules
  return [emptyStopRule()]
}

function cloneConditionBuckets(src) {
  const keys = ['prematch', 'inplay', 'settled']
  const out = {}
  for (const k of keys) {
    const b = src?.[k]
    out[k] = {
      enabled: !!b?.enabled,
      groups: Array.isArray(b?.groups)
        ? b.groups.map((g) => ({ ...emptyConditionGroup(), ...g }))
        : [emptyConditionGroup()],
    }
  }
  return out
}

function cloneBettingBuckets(src) {
  const out = {}
  for (const k of ['prematch', 'inplay']) {
    const b = src?.[k]
    out[k] = {
      enabled: !!b?.enabled,
      simulate: !!b?.simulate,
      groups: Array.isArray(b?.groups)
        ? b.groups.map((g) => {
          const base = { ...emptyBettingGroup(k), ...g }
          base.stopRules = ensureStopRules(base).map((r) => ({ ...emptyStopRule(), ...r }))
          return base
        })
        : [emptyBettingGroup(k)],
    }
    if (k === 'inplay') {
      out[k].entry = normalizeInplayEntryDraft(b?.entry)
    }
  }
  return out
}

function emptyInplayEntry() {
  return {
    requireWonFirstSet: true,
    firstSetExcludeEnabled: true,
    firstSetExcludeScore: '7:5',
    pmCentsMax: 91,
    rankGapRules: [],
  }
}

function normalizeInplayEntryDraft(raw) {
  const d = emptyInplayEntry()
  if (!raw || typeof raw !== 'object') {
    return {
      requireWonFirstSet: d.requireWonFirstSet,
      firstSetExcludeEnabled: d.firstSetExcludeEnabled,
      firstSetExcludeScore: d.firstSetExcludeScore,
      pmCentsMax: d.pmCentsMax,
      rankGapRules: [],
    }
  }
  const excludeScore = raw.firstSetExcludeScore != null && String(raw.firstSetExcludeScore).trim()
    ? String(raw.firstSetExcludeScore).trim().slice(0, 12)
    : d.firstSetExcludeScore
  return {
    requireWonFirstSet: raw.requireWonFirstSet !== false,
    firstSetExcludeEnabled: raw.firstSetExcludeEnabled === true
      || (raw.firstSetExcludeEnabled == null && raw.requireWonFirstSet !== false && d.firstSetExcludeEnabled),
    firstSetExcludeScore: excludeScore || '7:5',
    pmCentsMax: raw.pmCentsMax === '' || raw.pmCentsMax == null ? 'all' : raw.pmCentsMax,
    rankGapRules: [],
  }
}

const conditionDraft = ref(cloneConditionBuckets(null))
const bettingDraft = ref(cloneBettingBuckets(null))
/** 折叠态：key = `${tab}:${index}`，true=折叠 */
const conditionGroupCollapsed = ref({})
const bettingGroupCollapsed = ref({})

function groupCollapseKey(tab, index) {
  return `${tab}:${index}`
}
function isConditionGroupCollapsed(gi) {
  const k = groupCollapseKey(conditionTab.value, gi)
  // 未点过展开时默认折叠
  if (!(k in conditionGroupCollapsed.value)) return true
  return !!conditionGroupCollapsed.value[k]
}
function toggleConditionGroup(gi) {
  const k = groupCollapseKey(conditionTab.value, gi)
  conditionGroupCollapsed.value = {
    ...conditionGroupCollapsed.value,
    [k]: !isConditionGroupCollapsed(gi),
  }
}
function isBettingGroupCollapsed(gi) {
  const k = groupCollapseKey(bettingTab.value, gi)
  if (!(k in bettingGroupCollapsed.value)) return true
  return !!bettingGroupCollapsed.value[k]
}
function toggleBettingGroup(gi) {
  const k = groupCollapseKey(bettingTab.value, gi)
  bettingGroupCollapsed.value = {
    ...bettingGroupCollapsed.value,
    [k]: !isBettingGroupCollapsed(gi),
  }
}

/** 分组浅色底：按序号轮换 */
const GROUP_TINT_COUNT = 6
function groupTintClass(gi) {
  const n = Number(gi)
  const i = Number.isFinite(n) && n >= 0 ? Math.floor(n) % GROUP_TINT_COUNT : 0
  return `group-tint-${i}`
}

const activeConditionBucket = computed(() => conditionDraft.value?.[conditionTab.value] || {
  enabled: false,
  groups: [emptyConditionGroup()],
})

const activeBettingBucket = computed(() => {
  const b = bettingDraft.value?.[bettingTab.value]
  if (b) {
    if (bettingTab.value === 'inplay' && !b.entry) {
      return { ...b, entry: normalizeInplayEntryDraft(null) }
    }
    return b
  }
  return {
    enabled: false,
    simulate: false,
    groups: [emptyBettingGroup(bettingTab.value)],
    entry: bettingTab.value === 'inplay' ? normalizeInplayEntryDraft(null) : undefined,
  }
})

const loading = ref(true)
const refreshing = ref(false)
const collecting = ref(false)
const error = ref('')
const notice = ref('')
const status = ref(null)
const top100Board = ref(null)
const liveData = ref(null)
const logs = ref(null)
const logsClearing = ref(false)
const tab = ref('atp') // atp | wta | live | logs
const topPoolMax = ref('100') // 20 | 50 | 100
const tierFilter = ref({ gs: false, t1000: false, t500: false })
const onlyWithMatches = ref(false)
const expanded = ref({})
const schedule = ref(null)
const scheduleSaving = ref(false)
const dataSource = ref(null)
const dataSourceSaving = ref(false)
const engines = ref(null)
const enginesLoading = ref(false)
const enginesSaving = ref(false)
const conditionSaving = ref(false)
const bettingSaving = ref(false)
const conditionDraftDirty = ref(false)
const bettingDraftDirty = ref(false)

const stopOrders = ref([])
const stopOrdersLoading = ref(false)
const stopOrdersError = ref('')
const stopOrderLinkBusy = ref(null)

function stopGroupKey(g) {
  return String(g?.strategyKey || g?.id || '').trim()
}

function stopGroupLabel(g, gi) {
  const n = String(g?.name || '').trim()
  return n || `止损组 ${gi + 1}`
}

function orderBucketKey(row) {
  const bk = String(row?.bucket || '').trim()
  if (bk === 'prematch' || bk === 'inplay') return bk
  const p = String(row?.product || '').toLowerCase()
  if (p.includes('inplay') || p.includes('live')) return 'inplay'
  return 'prematch'
}

function orderIsOpenBuy(row) {
  if (!row || row.action !== 'buy' || row.ok === false) return false
  const market = String(row.market || '')
  const side = String(row.side || '').toLowerCase()
  if (!market || !side) return false
  const sells = stopOrders.value.filter((x) => x.action === 'sell' && x.ok !== false && String(x.market) === market && String(x.side).toLowerCase() === side)
  const buyId = Number(row.id)
  return !sells.some((s) => Number(s.id) > buyId)
}

const openStopOrders = computed(() => stopOrders.value.filter(orderIsOpenBuy))

function ordersLinkedToStopGroup(g) {
  const sk = stopGroupKey(g)
  if (!sk) return []
  return openStopOrders.value.filter((o) => String(o.strategyKey || '') === sk)
}

const stopGroupOptions = computed(() => {
  const tab = bettingTab.value
  const groups = bettingDraft.value?.[tab]?.groups || []
  return groups.map((g, gi) => ({
    key: stopGroupKey(g),
    label: stopGroupLabel(g, gi),
    bucket: tab,
  })).filter((o) => o.key)
})

async function loadStopOrders() {
  if (!isStopPage.value) return
  stopOrdersLoading.value = true
  stopOrdersError.value = ''
  try {
    const data = await api.fetchTennisBettingOrders({ limit: 200 })
    stopOrders.value = Array.isArray(data?.items) ? data.items : []
  } catch (e) {
    stopOrdersError.value = e?.response?.data?.error || e.message || '加载订单失败'
    stopOrders.value = []
  } finally {
    stopOrdersLoading.value = false
  }
}

async function linkOrderToStopGroup(order, groupKey, bucket) {
  if (!order?.id || !groupKey) return
  stopOrderLinkBusy.value = order.id
  stopOrdersError.value = ''
  try {
    await api.linkTennisBettingOrderStopGroup(order.id, {
      strategyKey: groupKey,
      bucket: bucket || orderBucketKey(order),
    })
    stopOrders.value = stopOrders.value.map((o) => (
      o.id === order.id ? { ...o, strategyKey: groupKey, bucket: bucket || orderBucketKey(order) } : o
    ))
    showNotice('已挂止损组')
  } catch (e) {
    stopOrdersError.value = e?.response?.data?.error || e.message || '挂止损组失败'
  } finally {
    stopOrderLinkBusy.value = null
  }
}

async function attachOrderToGroup(orderId, gi) {
  const g = bettingDraft.value?.[bettingTab.value]?.groups?.[gi]
  const sk = stopGroupKey(g)
  if (!sk) return
  const order = openStopOrders.value.find((o) => String(o.id) === String(orderId))
  if (!order) return
  await linkOrderToStopGroup(order, sk, bettingTab.value)
}

const playerPage = ref(1)
const livePage = ref(1)
const logPage = ref(1)
const statsOpen = ref(false)
const metricsOpen = ref(false)
const poolFilterOpen = ref(false)

const PLAYER_PAGE_SIZE = 15
const LIVE_PAGE_SIZE = 12
const LOG_PAGE_SIZE = 60

const HORIZON_OPTIONS = [
  { days: 1, label: '今天(1天)' },
  { days: 2, label: '今天起2天' },
  { days: 3, label: '今天起3天' },
  { days: 5, label: '今天起5天' },
]

const LIVE_POLL_OPTIONS = [
  { sec: 0, label: '关闭' },
  { sec: 60, label: '1 分钟' },
  { sec: 120, label: '2 分钟' },
  { sec: 300, label: '5 分钟' },
]

let pollTimer = null
let top100Timer = null
let liveTimer = null
let noticeTimer = null

const top100LoadingSince = ref(0)
const top100LoadingSec = ref(0)
let top100LoadingTick = null

const running = computed(() => !!(
  status.value?.top100_collect?.running
  || status.value?.running
))
const top100Collect = computed(() => status.value?.top100_collect || {})
const lastRun = computed(() => top100Collect.value?.last || status.value?.last_run || {})
const livePoll = computed(() => status.value?.live_poll?.last || liveData.value?.last || {})
const liveRunning = computed(() => !!(status.value?.live_poll?.running || liveData.value?.running))
const liveMatches = computed(() => {
  const list = livePoll.value?.events || []
  return Array.isArray(list) ? list : []
})
const bundle = computed(() => status.value?.latest_bundle || {})
const collectHorizonDays = computed(() => {
  const days = Number(schedule.value?.collect_horizon_days ?? status.value?.schedule?.collect_horizon_days)
  return HORIZON_OPTIONS.some((o) => o.days === days) ? days : 1
})
const collectHorizonLabel = computed(() => {
  const opt = HORIZON_OPTIONS.find((o) => o.days === collectHorizonDays.value)
  return opt?.label || schedule.value?.collect_horizon_label || `今天起${collectHorizonDays.value}天`
})
const livePollIntervalSec = computed(() => {
  const sec = Number(
    schedule.value?.live_poll_interval_sec
    ?? status.value?.schedule?.live_poll_interval_sec
    ?? status.value?.live_poll?.interval_sec
    ?? liveData.value?.interval_sec,
  )
  return LIVE_POLL_OPTIONS.some((o) => o.sec === sec) ? sec : 300
})
const collectEnabled = computed(() => {
  const v = schedule.value?.collect_enabled ?? status.value?.schedule?.collect_enabled
  return v !== false
})
const livePollIntervalLabel = computed(() => {
  const sec = livePollIntervalSec.value
  if (sec <= 0) return '关闭'
  const opt = LIVE_POLL_OPTIONS.find((o) => o.sec === sec)
  if (opt) return opt.label
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} 分钟`
  return `${sec} 秒`
})
const livePollAutoEnabled = computed(() => livePollIntervalSec.value > 0)
const LIVE_UI_REFRESH_MS = 60000
const tennisDataSource = computed(() => dataSource.value?.source || 'ipwo')
const isVirtualSource = computed(() => tennisDataSource.value === 'docks500')
const lastRealSource = ref('ipwo')
const tennisDataSourceLabel = computed(() => {
  if (tennisDataSource.value === 'docks500') return '虚拟(txt)'
  if (tennisDataSource.value === 'api') return 'AllSports API'
  return 'IPWO'
})

const pageSub = computed(() => {
  if (isConditionPage.value) {
    const b = engines.value?.condition?.buckets || {}
    const on = ['prematch', 'inplay', 'settled']
      .filter((k) => b[k]?.enabled)
      .map((k) => ({ prematch: '盘前', inplay: '盘中', settled: '盘后' }[k]))
    const account = engines.value?.betting?.userAccount || engines.value?.betting?.userId
    const buckets = on.length ? `已开：${on.join('、')}` : '各桶均未打开'
    return `${buckets} · 账号 ${account || '未设'} · 调度命中自动投注`
  }
  if (isBettingPage.value || isStopPage.value) {
    const b = engines.value?.betting?.buckets || {}
    const on = ['prematch', 'inplay']
      .filter((k) => b[k]?.enabled)
      .map((k) => ({ prematch: '盘前', inplay: '盘中' }[k]))
    const master = engines.value?.betting?.enabled ? '总开关开' : '总开关关'
    const account = engines.value?.betting?.userAccount || engines.value?.betting?.userId
    if (isStopPage.value) {
      const groups = ['prematch', 'inplay'].reduce((n, k) => n + (b[k]?.groups?.length || 0), 0)
      return `止损组 ${groups} · 账号 ${account || '未设'} · 与条件引擎共用账号`
    }
    return on.length
      ? `${master} · 已开：${on.join('、')} · 账号 ${account || '未设'}`
      : `${master} · 各桶均未打开 · 账号 ${account || '未设'}`
  }
  return `范围 ${collectHorizonLabel.value} · Redis ${tennisDataSourceLabel.value}`
})

watch(
  () => engines.value?.condition?.buckets,
  (buckets) => {
    if (!buckets || conditionDraftDirty.value) return
    conditionDraft.value = cloneConditionBuckets(buckets)
  },
  { deep: true, immediate: true },
)

watch(
  () => engines.value?.betting?.buckets,
  (buckets) => {
    if (!buckets || bettingDraftDirty.value) return
    bettingDraft.value = cloneBettingBuckets(buckets)
  },
  { deep: true, immediate: true },
)

watch(
  conditionTab,
  (t) => {
    if (isConditionPage.value && (t === 'prematch' || t === 'inplay')) {
      bettingTab.value = t
    }
  },
  { immediate: true },
)

const redisUpstreamLabel = computed(() => {
  const up = dataSource.value?.redis_upstream
  if (!up) return '—'
  if (String(up).includes('allsports')) return 'AllSports API'
  if (String(up).includes('ipwo')) return 'IPWO'
  if (String(up).includes('docks500') || String(up).includes('docks')) return '500回放'
  return up
})
const collectRequests = computed(() => (
  top100Collect.value?.last?.requests
  || top100Board.value?.requests
  || dataSource.value?.collect_requests
  || null
))
const polyMatchStats = computed(() => dataSource.value?.poly_match || null)
const redisRefreshStats = computed(() => dataSource.value?.redis_refresh || null)
const collectElapsedMs = computed(() => {
  const sec = top100Collect.value?.last?.elapsed_sec ?? top100Board.value?.elapsed_sec
  return sec != null ? sec * 1000 : null
})
const polyElapsedMs = computed(() => (
  polyMatchStats.value?.timingMs?.total ?? redisRefreshStats.value?.polyMs ?? null
))

function formatMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(1)} s`
}

function collectRequestHint(req) {
  if (!req || typeof req !== 'object') return '—'
  const parts = [
    `预热 ${req.warmup ?? 0}`,
    `API ${req.api ?? 0}`,
    `重试 ${req.retries ?? 0}`,
  ]
  const tier = req.collect?.tier
  if (tier != null) parts.push(`tier ${tier}`)
  return parts.join(' · ')
}

const summary = computed(() => ({
  ...(top100Board.value?.summary || {}),
  ...(top100Collect.value?.summary || {}),
  total_matches:
    top100Board.value?.summary?.total_matches
    ?? lastRun.value?.total_events
    ?? top100Collect.value?.summary?.total_matches,
}))

const TIER_OPTIONS = [
  { key: 'gs', label: '大满贯' },
  { key: 't1000', label: '1000' },
  { key: 't500', label: '500' },
]

function matchTierKey(m) {
  const level = String(m?.level || '').toLowerCase()
  const tour = String(m?.tournament || m?.tournamentShort || '').toLowerCase()
  const combined = `${level} ${tour}`
  if (
    /\bgs\b/.test(level)
    || combined.includes('grand slam')
    || ['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((x) => combined.includes(x))
  ) return 'gs'
  if (/\b1000\b/.test(level) || combined.includes('masters')) return 't1000'
  if (/\b500\b/.test(level) || /\b500\b/.test(tour)) return 't500'
  return 'other'
}

function tierFilterActive() {
  return TIER_OPTIONS.some((o) => tierFilter.value[o.key])
}

function matchPassesTier(m) {
  if (!tierFilterActive()) return true
  const key = matchTierKey(m)
  if (key === 'other') return false
  return !!tierFilter.value[key]
}

function playerMatchesFiltered(p) {
  return (Array.isArray(p?.matches) ? p.matches : []).filter(matchPassesTier)
}

function rankPoolPlayers(list) {
  const max = Number(topPoolMax.value) || 100
  return (Array.isArray(list) ? list : []).filter((p) => {
    const rank = Number(p.rank)
    return Number.isFinite(rank) && rank > 0 && rank <= max
  })
}

const players = computed(() => {
  const list = tab.value === 'wta' ? top100Board.value?.wta : top100Board.value?.atp
  return rankPoolPlayers(list).filter((p) => {
    const matches = playerMatchesFiltered(p)
    if (onlyWithMatches.value && !matches.length) return false
    return true
  }).map((p) => {
    const matches = playerMatchesFiltered(p)
    return { ...p, matches, matchCount: matches.length }
  })
})
const rawPoolPlayers = computed(() => rankPoolPlayers(
  tab.value === 'wta' ? top100Board.value?.wta : top100Board.value?.atp,
))
const poolSummary = computed(() => {
  const max = Number(topPoolMax.value) || 100
  let matches = 0
  for (const p of players.value) matches += Number(p.matchCount) || 0
  return { max, players: players.value.length, matches }
})
const playerPageCount = computed(() => Math.max(1, Math.ceil(players.value.length / PLAYER_PAGE_SIZE)))
const pagedPlayers = computed(() => {
  const start = (playerPage.value - 1) * PLAYER_PAGE_SIZE
  return players.value.slice(start, start + PLAYER_PAGE_SIZE)
})
const livePageCount = computed(() => Math.max(1, Math.ceil(liveMatches.value.length / LIVE_PAGE_SIZE)))
const pagedLiveMatches = computed(() => {
  const start = (livePage.value - 1) * LIVE_PAGE_SIZE
  return liveMatches.value.slice(start, start + LIVE_PAGE_SIZE)
})

const logLines = computed(() => {
  const raw = logs.value != null
    ? (logs.value.lines ?? logs.value.content ?? '')
    : (status.value?.latest_log_tail || '')
  if (!raw) return []
  return String(raw).split('\n').filter((line) => line.length)
})
const logPageCount = computed(() => Math.max(1, Math.ceil(logLines.value.length / LOG_PAGE_SIZE)))
const pagedLogText = computed(() => {
  const start = (logPage.value - 1) * LOG_PAGE_SIZE
  return logLines.value.slice(start, start + LOG_PAGE_SIZE).join('\n') || '(暂无日志)'
})

watch(logPageCount, (pages) => {
  if (logPage.value > pages) logPage.value = pages
})

function jumpLogToEnd() {
  logPage.value = logPageCount.value
}

const statusLabel = computed(() => {
  if (running.value) return '采集中'
  const s = lastRun.value.status
  if (s === 'success') return '最近成功'
  if (s === 'failed') return '最近失败'
  if (s === 'running') return '采集中'
  return '空闲'
})

const statusTone = computed(() => {
  if (running.value || lastRun.value.status === 'running') return 'run'
  if (lastRun.value.status === 'success') return 'ok'
  if (lastRun.value.status === 'failed') return 'err'
  return 'idle'
})

const busy = computed(() => (
  running.value
  || collecting.value
  || liveRunning.value
  || !!top100Board.value?.loading
))

function showNotice(msg) {
  notice.value = msg
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
    noticeTimer = null
  }, 8000)
}

function startTop100LoadingClock() {
  top100LoadingSince.value = Date.now()
  top100LoadingSec.value = 0
  if (top100LoadingTick) clearInterval(top100LoadingTick)
  top100LoadingTick = setInterval(() => {
    if (!top100Board.value?.loading) {
      stopTop100LoadingClock()
      return
    }
    top100LoadingSec.value = Math.floor((Date.now() - top100LoadingSince.value) / 1000)
  }, 1000)
}

function stopTop100LoadingClock() {
  if (top100LoadingTick) {
    clearInterval(top100LoadingTick)
    top100LoadingTick = null
  }
  top100LoadingSince.value = 0
  top100LoadingSec.value = 0
}

function toggle(id) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}

function formatMonitorError(raw) {
  const msg = String(raw || '').trim()
  if (!msg) return ''
  const low = msg.toLowerCase()
  if (low.includes('curl: (28)') || low.includes('connection timed out') || low.includes('timed out after')) {
    return '请求超时（代理或网络较慢），请稍后重试'
  }
  if (low.includes('curl: (7)') || low.includes('failed to connect')) {
    return '无法连接数据源/代理，请检查网络或代理配置'
  }
  if (low.includes('403') && (low.includes('forbidden') || low.includes('拒绝'))) {
    return '数据源拒绝访问（403），请检查代理 IP'
  }
  if (
    low.includes('monitor unreachable')
    || low.includes('无法连接采集监控服务')
    || low.includes('监控服务不可达')
    || low.includes('监控服务响应超时')
  ) {
    return '监控服务不可达，请确认采集服务是否运行'
  }
  return msg.replace(/sofascore/gi, '').replace(/\s{2,}/g, ' ').trim() || msg
}

/** 条件/投注/止损引擎配置（MySQL），与采集 monitor 无关 */
function formatEngineConfigError(raw) {
  const msg = String(raw || '').trim()
  if (!msg) return '引擎配置加载失败，请检查后端与 MySQL'
  const low = msg.toLowerCase()
  if (low.includes('network error') || low.includes('econnrefused') || low.includes('failed to fetch')) {
    return '无法连接后端服务，请确认 server 已启动'
  }
  if (/status code 50[234]/.test(low) || low.includes('bad gateway')) {
    return '后端服务异常，请确认 server 已启动且 MySQL 可用'
  }
  return msg.replace(/sofascore/gi, '').replace(/\s{2,}/g, ' ').trim() || '引擎配置加载失败'
}

function fmtTime(v) {
  if (!v) return '—'
  const s = String(v)
  if (s.includes('T')) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
  }
  return s.replace('T', ' ').slice(0, 19)
}

async function loadStatus() {
  status.value = await api.fetchTennisMonitorStatus()
}

async function loadTop100(force = false) {
  const data = await api.fetchTennisMonitorTop100(force)
  // 兼容嵌套 top100.atp / 顶层 atp，避免榜单在包里却列表为空
  const atp = data?.atp || data?.top100?.atp || data?.rankingsBoard?.atp || []
  const wta = data?.wta || data?.top100?.wta || data?.rankingsBoard?.wta || []
  top100Board.value = {
    ...data,
    atp: Array.isArray(atp) ? atp : [],
    wta: Array.isArray(wta) ? wta : [],
  }
  if (data?.loading) {
    startTop100LoadingClock()
    if (!top100Timer) {
      top100Timer = setInterval(async () => {
        try {
          const next = await api.fetchTennisMonitorTop100(false)
          top100Board.value = next
          if (!next?.loading) {
            clearInterval(top100Timer)
            top100Timer = null
            stopTop100LoadingClock()
            if (next?.error) {
              error.value = formatMonitorError(next.error)
            }
          }
        } catch {
          /* keep polling */
        }
      }, 2000)
    }
  } else {
    stopTop100LoadingClock()
    if (top100Timer) {
      clearInterval(top100Timer)
      top100Timer = null
    }
  }
}

async function loadLive() {
  liveData.value = await api.fetchTennisMonitorLive()
}


async function loadSchedule() {
  schedule.value = await api.fetchTennisMonitorSchedule()
}

async function loadDataSource() {
  dataSource.value = await api.fetchTennisMonitorDataSource()
  if (dataSource.value?.source === 'ipwo' || dataSource.value?.source === 'api') {
    lastRealSource.value = dataSource.value.source
  }
}

async function loadEngines({ background = false, force = false } = {}) {
  const showPanelLoading = isConfigOnlyPage.value && (!background || !engines.value)
  if (showPanelLoading) enginesLoading.value = true
  try {
    const data = await api.fetchTennisEngines({ force })
    engines.value = data
    return data
  } finally {
    if (showPanelLoading) enginesLoading.value = false
  }
}

async function loadLogs() {
  logs.value = await api.fetchTennisMonitorLogs(300)
  jumpLogToEnd()
}

async function clearCollectLogs() {
  if (!confirm('确认清空采集日志？此操作不可恢复。')) return
  logsClearing.value = true
  error.value = ''
  try {
    await api.clearTennisMonitorLogs()
    logs.value = { lines: '', content: '', file: '—' }
    logPage.value = 1
    notice.value = '采集日志已清空'
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '清空日志失败'
  } finally {
    logsClearing.value = false
  }
}

async function refreshAll({ silent = false } = {}) {
  if (!silent) {
    refreshing.value = true
    error.value = ''
    notice.value = ''
  }
  try {
    if (isConfigOnlyPage.value) {
      // 配置页只拉引擎配置；有缓存/草稿时后台刷新，不挡录入
      const background = !!engines.value
      void loadEngines({ background, force: !background })
        .then(() => {
          if (!engines.value) {
            error.value = error.value || '引擎配置加载失败，请检查后端 / MySQL 后刷新'
          } else if (!silent) {
            const kept = conditionDraftDirty.value || bettingDraftDirty.value
            showNotice(kept ? '已刷新（本地未保存修改已保留）' : '已刷新')
          }
        })
        .catch((e) => {
          error.value = formatEngineConfigError(e?.response?.data?.error || e?.message || '加载失败')
        })
        .finally(() => {
          if (!silent) refreshing.value = false
        })
      return
    }

    // 采集页：先出本地配置，status 后台补（避免卡在探测官网 monitor）
    const essential = await Promise.allSettled([
      loadEngines(),
      loadDataSource(),
      loadSchedule(),
    ])
    loading.value = false
    refreshing.value = false

    const heavy = await Promise.allSettled([
      loadStatus(),
      loadTop100(false),
      loadLive(),
      loadLogs(),
    ])
    const failed = [...essential, ...heavy].find((r) => r.status === 'rejected')
    if (failed && !silent) {
      const reason = failed.reason
      const msg = reason?.response?.data?.error || reason?.message || ''
      if (msg && !/9004|监控服务|monitor/i.test(msg)) {
        error.value = formatMonitorError(msg)
      }
    }
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '加载失败')
  } finally {
    loading.value = false
    if (!isConfigOnlyPage.value) refreshing.value = false
  }
}

async function waitCollectDone() {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    await loadStatus()
    await loadLogs()
    if (!running.value) {
      const err = lastRun.value?.error
      if (lastRun.value?.status === 'failed' && err) {
        notice.value = ''
        error.value = formatMonitorError(err)
      } else if (lastRun.value?.status === 'success') {
        error.value = ''
        const n = lastRun.value?.total_events
        if (n === 0 || lastRun.value?.message) {
          showNotice(lastRun.value?.message || '采集完成：无符合条件的比赛')
        } else {
          showNotice(`Top100 采集完成：${n ?? bundle.value?.event_count ?? '—'} 场比赛`)
        }
        api.refreshTennisCache().catch(() => {})
        api.refreshTennisNewCache().catch(() => {})
        try {
          await loadTop100(true)
        } catch (e) {
          console.warn('[TennisMonitor] loadTop100 after collect', e)
        }
        await loadDataSource()
        await loadLogs()
      }
      return
    }
  }
  notice.value = ''
  error.value = '采集仍在进行，请稍后在日志中查看结果'
}


async function triggerCollect() {
  if (collecting.value || running.value) return
  collecting.value = true
  error.value = ''
  notice.value = ''
  try {
    // 虚拟模式：只读 docks/2026_500.txt，不采官网
    if (isVirtualSource.value) {
      const r = await api.triggerTennisMonitorCollect({
        fromTxt: true,
        source: 'docks500',
        date: dataSource.value?.docks500?.date || undefined,
        prematchCount: 12,
        inplayCount: 12,
      })
      showNotice(
        r.message
        || `虚拟·txt（2026_500.txt · ${r.date || '-'}）：盘前 ${r.prematch ?? 0} · 盘中 ${r.inplay ?? 0} · 盘后 ${r.settled ?? 0}`,
      )
      try {
        const ds = await api.fetchTennisMonitorDataSource()
        dataSource.value = { ...(dataSource.value || {}), ...ds }
      } catch (_) { /* ignore */ }
      api.refreshTennisCache().catch(() => {})
      api.refreshTennisNewCache().catch(() => {})
      await loadTop100(true)
      await loadDataSource()
      await loadStatus()
      return
    }
    // 真实模式：官网 collect.py
    const r = await api.triggerTennisMonitorCollect({ fromTxt: false, top100: true })
    if (r?.skipped) {
      error.value = formatMonitorError(r.message || '采集已跳过')
      return
    }
    showNotice(r?.message || 'Top100 采集已启动')
    await loadStatus()
    await loadLogs()
    if (running.value) await waitCollectDone()
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '触发失败')
  } finally {
    collecting.value = false
  }
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
  return { home: home.join(' '), away: away.join(' ') }
}

function playerLiveScoreText(m, side) {
  const combined = m?.scoreText || m?.score_text || m?.score
  if (combined && typeof combined === 'string') {
    const parsed = parseScoreTextSides(combined)
    if (parsed) return parsed[side]
  }
  const raw = side === 'home' ? m?.homeScore : m?.awayScore
  if (raw == null || raw === '') return ''
  return String(raw)
}

async function onHorizonChange(event) {
  const days = Number(event.target.value)
  if (!HORIZON_OPTIONS.some((o) => o.days === days) || days === collectHorizonDays.value) return
  scheduleSaving.value = true
  error.value = ''
  try {
    const data = await api.updateTennisMonitorSchedule({ collect_horizon_days: days })
    schedule.value = data
    await loadStatus()
    showNotice(`采集范围已设为 ${HORIZON_OPTIONS.find((o) => o.days === days)?.label || days + '天'}（开始=今天）`)
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '更新采集范围失败')
    event.target.value = String(collectHorizonDays.value)
  } finally {
    scheduleSaving.value = false
  }
}

async function onLivePollIntervalChange(event) {
  const sec = Number(event.target.value)
  if (!LIVE_POLL_OPTIONS.some((o) => o.sec === sec) || sec === livePollIntervalSec.value) return
  scheduleSaving.value = true
  error.value = ''
  try {
    const data = await api.updateTennisMonitorSchedule({ live_poll_interval_sec: sec })
    schedule.value = data
    await Promise.all([loadStatus(), loadLive()])
    showNotice(`进行中拉取已设为 ${LIVE_POLL_OPTIONS.find((o) => o.sec === sec)?.label || sec + ' 秒'}`)
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '更新进行中频度失败')
    event.target.value = String(livePollIntervalSec.value)
  } finally {
    scheduleSaving.value = false
  }
}

async function patchEngines(patch) {
  const hasCondition = !!patch?.condition
  const hasBetting = !!patch?.betting
  if (hasCondition) conditionSaving.value = true
  if (hasBetting) bettingSaving.value = true
  if (!hasCondition && !hasBetting) enginesSaving.value = true
  error.value = ''
  try {
    engines.value = await api.updateTennisEngines(patch)
  if (hasCondition) {
      conditionDraftDirty.value = false
      conditionDraft.value = cloneConditionBuckets(engines.value?.condition?.buckets)
    }
    if (hasBetting) {
      bettingDraftDirty.value = false
      bettingDraft.value = cloneBettingBuckets(engines.value?.betting?.buckets)
    }
    showNotice('引擎配置已保存')
  } catch (e) {
    const raw = e?.response?.data?.error || e?.message || '更新引擎失败'
    error.value = (hasCondition || hasBetting)
      ? formatEngineConfigError(raw)
      : formatMonitorError(raw)
    await loadEngines().catch(() => {})
  } finally {
    if (hasCondition) conditionSaving.value = false
    if (hasBetting) bettingSaving.value = false
    if (!hasCondition && !hasBetting) enginesSaving.value = false
  }
}

function onBettingUserAccountChange(ev) {
  const account = String(ev?.target?.value || '').trim()
  patchEngines({ betting: { userAccount: account || null } })
}
function onBettingAmountUsdChange(ev) {
  const n = Number(ev?.target?.value)
  if (!Number.isFinite(n) || n <= 0) return
  patchEngines({ betting: { amountUsd: Math.round(n * 100) / 100 } })
}

function onListPollIntervalChange(field, ev) {
  const n = Number(ev?.target?.value)
  if (!Number.isFinite(n)) return
  let sec
  if (field === 'listPageRefreshIntervalSec') {
    sec = n <= 0 ? 0 : Math.max(10, Math.min(600, Math.round(n)))
  } else {
    sec = Math.max(10, Math.min(600, Math.round(n)))
  }
  patchEngines({ betting: { [field]: sec } })
}

function parseConditionNum(raw) {
  if (raw === 'all' || raw === '' || raw == null) return 'all'
  const n = Number(raw)
  return Number.isFinite(n) ? n : 'all'
}

function setGroupField(groupIndex, key, raw) {
  const tab = conditionTab.value
  const groups = [...(conditionDraft.value[tab].groups || [])]
  const g = { ...groups[groupIndex] }
  if (['gapMin', 'rankDiffMin', 'rankDiffMax', 'strongRankMax', 'strongRankGt', 'strongRankLt'].includes(key)) {
    g[key] = parseConditionNum(raw)
  } else if (key === 'joinPrev') {
    g[key] = raw === 'and' ? 'and' : 'or'
  } else if (key === 'name') {
    g[key] = String(raw || '').slice(0, 40)
  } else if (['requireWonFirstSet', 'firstSetExcludeEnabled', 'linkPrematch'].includes(key)) {
    g[key] = !!raw
  } else if (key === 'firstSetExcludeScore') {
    g[key] = String(raw || '').trim().slice(0, 12) || '7:5'
  } else {
    g[key] = raw
  }
  groups[groupIndex] = g
  conditionDraftDirty.value = true
  conditionDraft.value = {
    ...conditionDraft.value,
    [tab]: { ...conditionDraft.value[tab], groups },
  }
}

function setBucketEnabled(ev) {
  const tab = conditionTab.value
  conditionDraftDirty.value = true
  conditionDraft.value = {
    ...conditionDraft.value,
    [tab]: { ...conditionDraft.value[tab], enabled: !!ev?.target?.checked },
  }
}

function addConditionGroup() {
  const tab = conditionTab.value
  const groups = [...(conditionDraft.value[tab].groups || []), emptyConditionGroup()]
  conditionDraftDirty.value = true
  conditionDraft.value = {
    ...conditionDraft.value,
    [tab]: { ...conditionDraft.value[tab], groups },
  }
}

function removeConditionGroup(index) {
  const tab = conditionTab.value
  const groups = [...(conditionDraft.value[tab].groups || [])]
  groups.splice(index, 1)
  conditionDraftDirty.value = true
  conditionDraft.value = {
    ...conditionDraft.value,
    [tab]: { ...conditionDraft.value[tab], groups },
  }
  void saveConditionBucketAndEnable()
}

async function saveConditionBucketAndEnable() {
  const tab = conditionTab.value
  const bucket = conditionDraft.value[tab]
  await patchEngines({
    condition: {
      buckets: {
        [tab]: {
          enabled: !!bucket.enabled,
          groups: (bucket.groups || []).map((g) => ({
            ...emptyConditionGroup(),
            ...g,
            // 与投注一致：只用开区间强现> / 强现<，清掉旧 strongRankMax
            strongRankMax: 'all',
          })),
        },
      },
    },
  })
}

function setBettingGroupField(groupIndex, key, raw) {
  const tab = bettingTab.value
  const groups = [...(bettingDraft.value[tab].groups || [])]
  const g = { ...groups[groupIndex] }
  if (['gapMin', 'rankDiffMin', 'rankDiffMax', 'strongRankMax', 'strongRankGt', 'strongRankLt'].includes(key)) {
    g[key] = parseConditionNum(raw)
  } else if (key === 'pmMaxCents') {
    const n = Number(raw)
    g[key] = Number.isFinite(n) ? n : 91
  } else if (['requireWonFirstSet', 'stopEnabled', 'firstSetExcludeEnabled'].includes(key)) {
    g[key] = !!raw
  } else if (key === 'amountUsd') {
    const n = Number(raw)
    g[key] = Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : 1
  } else if (key === 'firstSetExcludeScore') {
    g[key] = String(raw || '').trim().slice(0, 16)
  } else if (key === 'joinPrev') {
    g[key] = raw === 'and' ? 'and' : 'or'
  } else if (key === 'name') {
    g[key] = String(raw || '').slice(0, 40)
  } else {
    g[key] = raw
  }
  if (!Array.isArray(g.stopRules)) g.stopRules = []
  if (key === 'stopEnabled' && g.stopEnabled && g.stopRules.length === 0) {
    g.stopRules = [emptyStopRule()]
  }
  groups[groupIndex] = g
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], groups },
  }
}

function setStopRuleField(groupIndex, ruleIndex, key, raw) {
  const tab = bettingTab.value
  const groups = [...(bettingDraft.value[tab].groups || [])]
  const g = { ...groups[groupIndex] }
  const rules = [...ensureStopRules(g)]
  const r = { ...emptyStopRule(), ...rules[ruleIndex] }
  if (['stopStrongSets', 'stopWeakSets', 'stopWeakGamesMin', 'stopPmCentsMax'].includes(key)) {
    r[key] = parseConditionNum(raw)
  } else if (['stopGameLead', 'stopSetIndex'].includes(key)) {
    const s = String(raw ?? '').trim()
    if (!s) r[key] = 'all'
    else {
      const n = Number(s)
      if (key === 'stopSetIndex') r[key] = Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 'all'
      else r[key] = Number.isFinite(n) ? n : 'all'
    }
  } else if (key === 'joinPrev') {
    r[key] = raw === 'and' ? 'and' : 'or'
  } else if (key === 'name') {
    r[key] = String(raw || '').slice(0, 40)
  } else {
    r[key] = raw
  }
  rules[ruleIndex] = r
  g.stopRules = rules
  groups[groupIndex] = g
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], groups },
  }
}

function addStopRule(groupIndex) {
  const tab = bettingTab.value
  const groups = [...(bettingDraft.value[tab].groups || [])]
  const g = { ...groups[groupIndex] }
  const prev = Array.isArray(g.stopRules) ? g.stopRules : []
  g.stopRules = [...prev, emptyStopRule()]
  g.stopEnabled = true
  groups[groupIndex] = g
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], groups },
  }
}

function removeStopRule(groupIndex, ruleIndex) {
  const tab = bettingTab.value
  const groups = [...(bettingDraft.value[tab].groups || [])]
  const g = { ...groups[groupIndex] }
  const rules = [...ensureStopRules(g)]
  rules.splice(ruleIndex, 1)
  g.stopRules = rules
  groups[groupIndex] = g
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], groups },
  }
  void saveBettingBucketAndEnable()
}

function setBettingBucketEnabled(ev) {
  const tab = bettingTab.value
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], enabled: !!ev?.target?.checked },
  }
}

function setBettingBucketSimulate(ev) {
  const tab = bettingTab.value
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], simulate: !!ev?.target?.checked },
  }
}

function ensureInplayEntry() {
  const cur = bettingDraft.value.inplay || {}
  if (!cur.entry) {
    bettingDraft.value = {
      ...bettingDraft.value,
      inplay: { ...cur, entry: normalizeInplayEntryDraft(null) },
    }
  }
}

function setInplayEntryField(key, raw) {
  ensureInplayEntry()
  const cur = bettingDraft.value.inplay
  const entry = { ...normalizeInplayEntryDraft(cur.entry) }
  if (key === 'requireWonFirstSet') entry.requireWonFirstSet = !!raw
  else if (key === 'firstSetExcludeEnabled') entry.firstSetExcludeEnabled = !!raw
  else if (key === 'firstSetExcludeScore') {
    const s = String(raw ?? '').trim().slice(0, 12)
    entry.firstSetExcludeScore = s || '7:5'
  } else if (key === 'pmCentsMax') {
    const s = String(raw ?? '').trim()
    entry.pmCentsMax = s === '' ? 'all' : (Number.isFinite(Number(s)) ? Number(s) : 'all')
  }
  bettingDraftDirty.value = true
  bettingDraft.value = { ...bettingDraft.value, inplay: { ...cur, entry } }
}

function addBettingGroup() {
  const tab = bettingTab.value
  const groups = [...(bettingDraft.value[tab].groups || []), emptyBettingGroup(tab)]
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], groups },
  }
}

function removeBettingGroup(index) {
  const tab = bettingTab.value
  const groups = [...(bettingDraft.value[tab].groups || [])]
  groups.splice(index, 1)
  bettingDraftDirty.value = true
  bettingDraft.value = {
    ...bettingDraft.value,
    [tab]: { ...bettingDraft.value[tab], groups },
  }
  void saveBettingBucketAndEnable()
}

async function saveBettingBucketAndEnable() {
  const tab = bettingTab.value
  const bucket = bettingDraft.value[tab]
  await patchEngines({
    betting: {
      // 总开关已废弃：任意桶打开即可投注
      enabled: true,
      buckets: {
        [tab]: {
          enabled: !!bucket.enabled,
          simulate: !!bucket.simulate,
          groups: (bucket.groups || []).map((g) => {
            const base = { ...emptyBettingGroup(tab), ...g }
            const id = String(base.id || '').trim() || emptyBettingGroup(tab).id
            return {
            ...base,
            id,
            strategyKey: String(base.strategyKey || id).trim() || id,
            amountUsd: Number(g.amountUsd) >= 1 ? Math.round(Number(g.amountUsd) * 100) / 100 : 1,
            // 投注引擎只用开区间强现> / 强现<，避免旧 strongRankMax 暗中生效
            strongRankMax: 'all',
            stopRules: ensureStopRules(g).map((r) => ({ ...emptyStopRule(), ...r })),
            }
          }),
          ...(tab === 'inplay' ? {
            entry: (() => {
              const e = normalizeInplayEntryDraft(bucket.entry)
              return {
                requireWonFirstSet: e.requireWonFirstSet !== false,
                firstSetExcludeEnabled: !!e.firstSetExcludeEnabled,
                firstSetExcludeScore: e.firstSetExcludeScore || '7:5',
                pmCentsMax: e.pmCentsMax === '' || e.pmCentsMax == null ? 'all' : e.pmCentsMax,
                rankGapRules: [],
              }
            })(),
          } : {}),
        },
      },
    },
  })
}

async function onSeedVirtualBuckets() {
  enginesSaving.value = true
  try {
    const r = await api.seedTennisVirtualBuckets({ prematchCount: 12, inplayCount: 12 })
    const vs = r.virtualSim || {}
    showNotice(
      `虚拟·txt（${r.txtSource || r.from || '-'} · ${r.date || '-'}）：`
      + `盘前 ${r.prematch ?? vs.prematch ?? 0}`
      + ` · 盘中 ${r.inplay ?? vs.inplay ?? 0}`
      + ` · 盘后 ${r.settled ?? vs.settled ?? 0}`,
    )
    // 切到虚拟源后刷新状态
    try {
      const ds = await api.fetchTennisMonitorDataSource()
      dataSource.value = { ...(dataSource.value || {}), ...ds }
    } catch (_) { /* ignore */ }
    api.refreshTennisCache().catch(() => {})
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '造盘前/盘中失败')
  } finally {
    enginesSaving.value = false
  }
}
async function onDataSourceChange(next, date) {
  if (dataSourceSaving.value) return
  if (next === tennisDataSource.value && !date) return
  if (next === 'api' && !dataSource.value?.api_available) {
    error.value = 'AllSports API 未配置（需 RAPIDAPI_KEY）'
    return
  }
  if (next === 'docks500' && dataSource.value?.docks500_available === false) {
    error.value = '虚拟数据不可用（检查 docks/*.txt，如 2026_all_gs_1000_500.txt）'
    return
  }
  // 切到虚拟前记住真实源，方便关虚拟时还原
  if (next === 'docks500' && (tennisDataSource.value === 'ipwo' || tennisDataSource.value === 'api')) {
    lastRealSource.value = tennisDataSource.value
  }
  if (next === 'ipwo' || next === 'api') {
    lastRealSource.value = next
  }
  dataSourceSaving.value = true
  error.value = ''
  notice.value = ''
  try {
    const payload = { source: next }
    if (next === 'docks500' && date) payload.date = date
    const data = await api.updateTennisMonitorDataSource(payload)
    dataSource.value = { ...(dataSource.value || {}), ...data }
    showNotice(data.message || `已切换为 ${data.label || next}`)
    api.refreshTennisCache().catch(() => {})
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '切换数据源失败')
  } finally {
    dataSourceSaving.value = false
  }
}

async function onVirtualToggle(ev) {
  const on = !!ev?.target?.checked
  if (on) {
    await onDataSourceChange('docks500')
  } else {
    const real = lastRealSource.value === 'api' && dataSource.value?.api_available
      ? 'api'
      : 'ipwo'
    await onDataSourceChange(real)
  }
}

async function onDocks500DateChange(ev) {
  const date = ev?.target?.value
  if (!date) return
  await onDataSourceChange('docks500', date)
}

async function refreshTop100() {
  if (running.value) {
    error.value = 'Top100 采集进行中，请稍后再重拉'
    return
  }
  error.value = ''
  notice.value = ''
  try {
    await loadTop100(true)
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '刷新 Top100 失败')
  }
}

function setPlayerPage(page) {
  playerPage.value = Math.min(Math.max(1, page), playerPageCount.value)
}

function setLivePage(page) {
  livePage.value = Math.min(Math.max(1, page), livePageCount.value)
}


function setLogPage(page) {
  logPage.value = Math.min(Math.max(1, page), logPageCount.value)
}

function toggleTier(key) {
  tierFilter.value = { ...tierFilter.value, [key]: !tierFilter.value[key] }
}

function openPoolView(tour) {
  tab.value = tour
  poolFilterOpen.value = true
}

function tierFilterSummary() {
  const on = TIER_OPTIONS.filter((o) => tierFilter.value[o.key]).map((o) => o.label)
  return on.length ? on.join(' · ') : '未选'
}

const poolFilterSummary = computed(() => {
  const parts = [`Top${topPoolMax.value}`]
  if (tierFilterActive()) parts.push(tierFilterSummary())
  if (onlyWithMatches.value) parts.push('仅有赛事')
  return parts.join(' · ')
})

function playerPageLabel() {
  if (!players.value.length) return '0 条'
  const start = (playerPage.value - 1) * PLAYER_PAGE_SIZE + 1
  const end = Math.min(playerPage.value * PLAYER_PAGE_SIZE, players.value.length)
  return `${start}-${end} / ${players.value.length}`
}

function livePageLabel() {
  if (!liveMatches.value.length) return '0 条'
  const start = (livePage.value - 1) * LIVE_PAGE_SIZE + 1
  const end = Math.min(livePage.value * LIVE_PAGE_SIZE, liveMatches.value.length)
  return `${start}-${end} / ${liveMatches.value.length}`
}


function logPageLabel() {
  if (!logLines.value.length) return '0 行'
  const start = (logPage.value - 1) * LOG_PAGE_SIZE + 1
  const end = Math.min(logPage.value * LOG_PAGE_SIZE, logLines.value.length)
  return `${start}-${end} / ${logLines.value.length}`
}

watch([tab, topPoolMax, tierFilter, onlyWithMatches], () => {
  playerPage.value = 1
  expanded.value = {}
})
watch(tab, (t) => {
  livePage.value = 1
  logPage.value = 1
  if (t !== 'atp' && t !== 'wta') poolFilterOpen.value = false
})
watch(poolFilterOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
})
watch(players, (list) => {
  if (playerPage.value > Math.max(1, Math.ceil(list.length / PLAYER_PAGE_SIZE))) {
    playerPage.value = 1
  }
})
watch(liveMatches, (list) => {
  if (livePage.value > Math.max(1, Math.ceil(list.length / LIVE_PAGE_SIZE))) {
    livePage.value = 1
  }
})
watch(logLines, () => {
  if (logPage.value > logPageCount.value) logPage.value = 1
})

onMounted(() => {
  // 从盘前/盘中列表跳转进来时，定位到对应桶
  try {
    const raw = sessionStorage.getItem('tennis_engine_focus')
    if (raw) {
      const focus = JSON.parse(raw)
      sessionStorage.removeItem('tennis_engine_focus')
      const bucket = focus?.bucket
      if (isConditionPage.value && ['prematch', 'inplay', 'settled'].includes(bucket)) {
        conditionTab.value = bucket
      }
      if ((isBettingPage.value || isStopPage.value) && ['prematch', 'inplay'].includes(bucket)) {
        bettingTab.value = bucket
      }
    }
  } catch (_) { /* ignore */ }

  if (isConfigOnlyPage.value) {
    loading.value = false
    const cached = api.peekTennisEnginesCache({ allowStale: true })
    if (cached) engines.value = cached
  }

  refreshAll()
  if (isStopPage.value) loadStopOrders()
  // 仅采集页轮询官网状态 / live；条件与投注页不打扰
  if (isCollectPage.value) {
    pollTimer = setInterval(() => {
      loadStatus().catch(() => {})
      if (running.value) loadLogs().catch(() => {})
    }, 5000)
    liveTimer = setInterval(() => {
      loadLive().catch(() => {})
    }, LIVE_UI_REFRESH_MS)
  }
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (top100Timer) clearInterval(top100Timer)
  if (liveTimer) clearInterval(liveTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
  stopTop100LoadingClock()
  document.body.style.overflow = ''
})
</script>

<template>
  <div class="tennis-monitor">
    <div class="toolbar">
      <div class="titles">
        <div class="title">{{ pageTitle }}</div>
        <div class="sub">{{ pageSub }}</div>
      </div>
      <div class="actions-primary">
        <button type="button" class="btn ghost" :disabled="refreshing" @click="refreshAll()">刷新</button>
        <template v-if="isCollectPage">
          <button type="button" class="btn primary" :disabled="collecting || running" @click="triggerCollect" :title="isVirtualSource ? '虚拟：只读 docks/2026_500.txt，不采官网' : '真实：运行 collect.py 采官网'">
            {{
              running ? '采集中…'
                : collecting ? (isVirtualSource ? 'txt 造数中…' : '触发中…')
                  : (isVirtualSource ? '立即采集（仅 txt）' : '立即采集 Top100')
            }}
          </button>
        </template>
      </div>
    </div>

    <div v-if="!pageBlockingLoading" class="engine-panels">
      <section v-if="isCollectPage" class="engine-panel" id="engine-collect">
        <div class="engine-panel-head">
          <h3>采集引擎</h3>
          <span class="engine-panel-tag">全量采集</span>
        </div>
        <div class="settings-row engines-row">
          <label class="collect-toggle">
            <span>虚拟</span>
            <input
              type="checkbox"
              :checked="isVirtualSource"
              :disabled="dataSourceSaving || loading || (dataSource && dataSource.docks500_available === false)"
              @change="onVirtualToggle"
            >
            <span class="toggle-state" :class="{ off: !isVirtualSource }">{{ isVirtualSource ? '虚拟·txt' : '真实采集' }}</span>
          </label>
          <div
            v-if="!isVirtualSource"
            class="source-group"
            role="radiogroup"
            aria-label="真实采集数据源"
          >
            <span class="source-label">真实源</span>
            <label class="source-opt" :class="{ on: tennisDataSource === 'ipwo' }">
              <input
                type="radio"
                name="tennis-data-source"
                value="ipwo"
                :checked="tennisDataSource === 'ipwo'"
                :disabled="dataSourceSaving || loading"
                @change="onDataSourceChange('ipwo')"
              >
              IPWO
            </label>
            <label class="source-opt" :class="{ on: tennisDataSource === 'api', disabled: !dataSource?.api_available }">
              <input
                type="radio"
                name="tennis-data-source"
                value="api"
                :checked="tennisDataSource === 'api'"
                :disabled="dataSourceSaving || loading || !dataSource?.api_available"
                @change="onDataSourceChange('api')"
              >
              API
            </label>
          </div>
          <label
            v-if="isVirtualSource"
            class="interval-select"
          >
            <span>虚拟日</span>
            <select
              :value="dataSource?.docks500?.date || ''"
              :disabled="dataSourceSaving || loading || !(dataSource?.docks500?.days?.length)"
              @change="onDocks500DateChange"
            >
              <option
                v-for="d in (dataSource?.docks500?.days || [])"
                :key="d.date"
                :value="d.date"
              >
                {{ d.date }} · {{ d.matchCount }}场 · {{ (d.tournaments || []).slice(0, 2).join('/') }}
              </option>
            </select>
          </label>
          <button
            v-if="isVirtualSource"
            type="button"
            class="btn ghost"
            :disabled="dataSourceSaving || loading || !dataSource?.docks500?.date"
            title="打开虚拟日编辑页"
            @click="emit('open-docks-editor', dataSource?.docks500?.date)"
          >编辑本虚拟日</button>
          <button
            type="button"
            class="btn ghost"
            title="电脑宽屏查看 ATP/WTA Top100"
            @click="emit('open-top100-wide')"
          >Top100 宽屏</button>
          <label class="interval-select" title="开始固定为今天；结束可选跨度">
            <span>采集范围</span>
            <select
              :value="collectHorizonDays"
              :disabled="scheduleSaving || loading || running || isVirtualSource"
              @change="onHorizonChange"
            >
              <option v-for="opt in HORIZON_OPTIONS" :key="opt.days" :value="opt.days">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <button type="button" class="btn ghost" :disabled="enginesSaving || !engines" @click="onSeedVirtualBuckets" title="用 docks 已下载的 txt 比赛数据模拟盘前/盘中并写入 Redis">虚拟·txt造数</button>
        </div>
      </section>

      <section v-if="isConditionPage" class="engine-panel" id="engine-condition">
        <div class="engine-panel-head">
          <h3>条件引擎</h3>
          <span v-if="engines" class="engine-panel-tag">分桶开关 · 打开即筛列表</span>
          <span v-else-if="enginesLoading" class="engine-panel-tag muted">加载中…</span>
        </div>
        <p v-if="enginesLoading && !engines" class="engines-note">配置加载中…</p>
        <p v-else-if="!engines" class="engines-note">配置尚未加载。请确认后端已启动且 MySQL 可用，然后点右上角「刷新」。</p>
        <template v-else>
        <p class="engines-note" style="margin:0 0 8px">
          各条件组相互独立。盘前组勾选「关联未开赛」并保存后，未开赛列表会按这些组筛选；也可在产品管理中挂载到具体产品以覆盖默认。
          条件桶需打开。在调度中心添加「条件引擎」任务后，命中数据将自动调用投注（无需单独配置投注引擎）。
        </p>

        <div class="settings-row engines-row">
          <label class="interval-select">
            <span>投注账号登录邮箱</span>
            <input
              type="email"
              style="width: 14rem"
              :value="engines.betting?.userAccount || ''"
              placeholder="登录邮箱"
              @change="onBettingUserAccountChange"
            >
          </label>
          <label class="interval-select">
            <span>默认金额 (USD)</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              style="width: 6.5rem"
              :value="engines.betting?.amountUsd ?? 1"
              @change="onBettingAmountUsdChange"
            >
          </label>
        </div>

        <div class="condition-tabs" role="tablist">
          <button
            v-for="t in CONDITION_TABS"
            :key="t.id"
            type="button"
            class="condition-tab"
            :class="{ on: conditionTab === t.id, enabled: conditionDraft[t.id]?.enabled }"
            role="tab"
            :aria-selected="conditionTab === t.id"
            @click="conditionTab = t.id"
          >
            {{ t.label }}
            <span class="dot" :class="{ on: conditionDraft[t.id]?.enabled }" />
          </button>
        </div>

        <div class="condition-tab-panel">
          <div class="settings-row engines-row">
            <label class="collect-toggle">
              <span>{{ CONDITION_TABS.find(t => t.id === conditionTab)?.label }}打开</span>
              <input
                type="checkbox"
                :checked="!!activeConditionBucket.enabled"
                @change="setBucketEnabled"
              >
              <span class="toggle-state" :class="{ off: !activeConditionBucket.enabled }">{{ activeConditionBucket.enabled ? '已开启' : '已关闭' }}</span>
            </label>
            <label v-if="conditionTab === 'prematch'" class="collect-toggle" title="虚拟采集时强制模拟；真实采集时按此开关">
              <span>模拟投注</span>
              <input
                type="checkbox"
                :checked="!!activeBettingBucket.simulate"
                @change="setBettingBucketSimulate"
              >
              <span class="toggle-state" :class="{ off: !activeBettingBucket.simulate }">{{ activeBettingBucket.simulate ? '模拟' : '实盘' }}</span>
            </label>
            <button type="button" class="btn ghost" @click="addConditionGroup">加一组条件</button>
            <button type="button" class="btn primary" :disabled="conditionSaving" @click="saveConditionBucketAndEnable">
              {{ conditionSaving ? '保存中…' : '保存本桶' }}
            </button>
            <button
              v-if="conditionTab === 'prematch' || conditionTab === 'inplay'"
              type="button"
              class="btn ghost"
              :disabled="bettingSaving"
              @click="saveBettingBucketAndEnable"
            >{{ bettingSaving ? '保存中…' : '保存投注参数' }}</button>
            <span v-if="conditionDraftDirty" class="dirty-hint">有未保存修改</span>
            <span v-else-if="bettingDraftDirty" class="dirty-hint">投注参数未保存</span>
          </div>

          <div v-if="conditionTab === 'inplay'" class="condition-group-wrap inplay-entry-panel">
            <div class="condition-group-head">
              <div class="condition-group-title">盘中自动买入条件</div>
              <div class="condition-group-hint">列表「自动投注」与调度条件命中后的买入共用</div>
            </div>
            <div class="condition-fields">
              <label class="collect-toggle">
                <span>须赢首盘</span>
                <input
                  type="checkbox"
                  :checked="!!activeBettingBucket.entry?.requireWonFirstSet"
                  @change="setInplayEntryField('requireWonFirstSet', $event.target.checked)"
                >
              </label>
              <label
                v-if="activeBettingBucket.entry?.requireWonFirstSet"
                class="collect-toggle"
                title="首盘局分为该比分时不买入（顺序无关，默认 7:5）"
              >
                <span>排除首盘</span>
                <input
                  type="checkbox"
                  :checked="!!activeBettingBucket.entry?.firstSetExcludeEnabled"
                  @change="setInplayEntryField('firstSetExcludeEnabled', $event.target.checked)"
                >
              </label>
              <label
                v-if="activeBettingBucket.entry?.requireWonFirstSet && activeBettingBucket.entry?.firstSetExcludeEnabled"
                title="仅排除第一盘该局分，如 7:5 / 7-5"
              >
                局分
                <input
                  type="text"
                  :value="activeBettingBucket.entry?.firstSetExcludeScore || '7:5'"
                  placeholder="7:5"
                  @change="setInplayEntryField('firstSetExcludeScore', $event.target.value)"
                >
              </label>
              <label>买入侧 PM¢&lt;
                <input
                  type="number"
                  min="1"
                  max="99"
                  :value="activeBettingBucket.entry?.pmCentsMax === 'all' || activeBettingBucket.entry?.pmCentsMax == null || activeBettingBucket.entry?.pmCentsMax === '' ? '' : activeBettingBucket.entry.pmCentsMax"
                  placeholder="不限"
                  @change="setInplayEntryField('pmCentsMax', $event.target.value)"
                >
              </label>
            </div>
          </div>

          <div
            v-for="(g, gi) in activeConditionBucket.groups"
            :key="(g.id || conditionTab) + '-' + gi"
            class="condition-group-wrap"
          >
            <div class="condition-group-card" :class="[groupTintClass(gi), { collapsed: isConditionGroupCollapsed(gi) }]">
            <div class="condition-group-head">
              <button
                type="button"
                class="group-fold-btn"
                :aria-expanded="!isConditionGroupCollapsed(gi)"
                :title="isConditionGroupCollapsed(gi) ? '展开' : '折叠'"
                @click="toggleConditionGroup(gi)"
              >{{ isConditionGroupCollapsed(gi) ? '▸' : '▾' }}</button>
              <label
                v-if="conditionTab === 'prematch'"
                class="bf-check group-link-check"
                title="勾选后，未开赛列表默认按本组筛选；也可在产品管理中挂载到具体产品"
              >
                <input
                  type="checkbox"
                  :checked="!!g.linkPrematch"
                  @change="setGroupField(gi, 'linkPrematch', $event.target.checked)"
                >
                <span>关联未开赛</span>
              </label>
              <input
                class="group-name-input"
                type="text"
                maxlength="40"
                :value="g.name || ''"
                :placeholder="groupDisplayName(g, gi)"
                @change="setGroupField(gi, 'name', $event.target.value)"
              >
              <span class="muted">组内字段「且」</span>
              <button
                type="button"
                class="btn ghost sm"
                @click="removeConditionGroup(gi)"
              >删除</button>
            </div>
            <div v-show="!isConditionGroupCollapsed(gi)" class="condition-group-body">
            <div class="betting-buy-fields">
              <label class="bf-field">
                <span>巡回</span>
                <select :value="g.tour || 'all'" @change="setGroupField(gi, 'tour', $event.target.value)">
                  <option value="all">全部</option>
                  <option value="ATP">男</option>
                  <option value="WTA">女</option>
                </select>
              </label>
              <label class="bf-field">
                <span>PM</span>
                <select :value="g.pm || 'all'" @change="setGroupField(gi, 'pm', $event.target.value)">
                  <option value="all">全部</option>
                  <option value="yes">有外链</option>
                  <option value="no">无外链</option>
                </select>
              </label>
              <label class="bf-field">
                <span>现差≥</span>
                <input
                  type="number"
                  :value="g.gapMin === 'all' || g.gapMin == null ? '' : g.gapMin"
                  placeholder="—"
                  @change="setGroupField(gi, 'gapMin', $event.target.value)"
                >
              </label>
              <div class="bf-pair" title="排差区间：≥ 下限 且 ≤ 上限">
                <label class="bf-inline">
                  <span>排差≥</span>
                  <input
                    type="number"
                    :value="g.rankDiffMin === 'all' || g.rankDiffMin == null ? '' : g.rankDiffMin"
                    placeholder="—"
                    @change="setGroupField(gi, 'rankDiffMin', $event.target.value)"
                  >
                </label>
                <label class="bf-inline">
                  <span>≤</span>
                  <input
                    type="number"
                    :value="g.rankDiffMax === 'all' || g.rankDiffMax == null ? '' : g.rankDiffMax"
                    placeholder="—"
                    @change="setGroupField(gi, 'rankDiffMax', $event.target.value)"
                  >
                </label>
              </div>
              <div class="bf-pair" title="开区间：如 0 &lt; x &lt; 10">
                <label class="bf-inline">
                  <span>强现</span>
                  <input
                    type="number"
                    :value="g.strongRankGt === 'all' || g.strongRankGt == null ? '' : g.strongRankGt"
                    placeholder="—"
                    @change="setGroupField(gi, 'strongRankGt', $event.target.value)"
                  >
                </label>
                <span class="bf-mid">&lt;x&lt;</span>
                <label class="bf-inline">
                  <span class="sr-only">强现上限</span>
                  <input
                    type="number"
                    :value="g.strongRankLt === 'all' || g.strongRankLt == null ? '' : g.strongRankLt"
                    placeholder="—"
                    @change="setGroupField(gi, 'strongRankLt', $event.target.value)"
                  >
                </label>
              </div>
              <label v-if="conditionTab === 'inplay'" class="bf-field">
                <span>现差分档</span>
                <select :value="g.gapMode || 'all'" @change="setGroupField(gi, 'gapMode', $event.target.value)">
                  <option value="all">不限</option>
                  <option value="tier">分档达标</option>
                </select>
              </label>
              <label
                v-if="conditionTab === 'inplay' || conditionTab === 'settled'"
                class="bf-check"
                title="强者须已赢下第一盘"
              >
                <input
                  type="checkbox"
                  :checked="!!g.requireWonFirstSet"
                  @change="setGroupField(gi, 'requireWonFirstSet', $event.target.checked)"
                >
                <span>赢首盘</span>
              </label>
              <label
                v-if="(conditionTab === 'inplay' || conditionTab === 'settled') && g.requireWonFirstSet"
                class="bf-check"
                title="首盘局分为该比分时不入选（顺序无关，默认 7:5）"
              >
                <input
                  type="checkbox"
                  :checked="!!g.firstSetExcludeEnabled"
                  @change="setGroupField(gi, 'firstSetExcludeEnabled', $event.target.checked)"
                >
                <span>排除首盘</span>
              </label>
              <label
                v-if="(conditionTab === 'inplay' || conditionTab === 'settled') && g.requireWonFirstSet && g.firstSetExcludeEnabled"
                class="bf-field"
                title="仅排除第一盘该局分，如 7:5 / 7-5"
              >
                <span>局分</span>
                <input
                  type="text"
                  :value="g.firstSetExcludeScore || '7:5'"
                  placeholder="7:5"
                  @change="setGroupField(gi, 'firstSetExcludeScore', $event.target.value)"
                >
              </label>
            </div>
            <p class="condition-group-hint">
              强现为开区间（如 0&lt;x&lt;10）；组内字段「且」。盘中/盘后可勾「赢首盘」并排除首盘局分（默认 7:5）。盘前组勾选「关联未开赛」后，到产品管理选用本组。
            </p>
            </div>
            </div>
          </div>
        </div>
        </template>
      </section>

      <section v-if="isBettingOrStopPage" class="engine-panel" :id="isStopPage ? 'engine-stop' : 'engine-betting'">
        <div class="engine-panel-head">
          <h3>{{ isStopPage ? '止损引擎' : '投注引擎' }}</h3>
          <span v-if="engines" class="engine-panel-tag">{{ isStopPage ? '盘前/盘中 · 止损组 · 可挂调度' : '盘前/盘中 · 买入与止损' }}</span>
          <span v-else-if="enginesLoading" class="engine-panel-tag muted">加载中…</span>
        </div>
        <p v-if="enginesLoading && !engines" class="engines-note">配置加载中…</p>
        <p v-else-if="!engines" class="engines-note">配置尚未加载。请确认后端已启动且 MySQL 可用，然后点右上角「刷新」。</p>
        <template v-else>
        <div class="settings-row engines-row">
          <label class="interval-select">
            <span>投注账号登录邮箱</span>
            <input
              type="email"
              style="width: 14rem"
              :value="engines.betting?.userAccount || ''"
              placeholder="登录邮箱"
              @change="onBettingUserAccountChange"
            >
          </label>
          <label v-if="isBettingPage" class="interval-select">
            <span>默认金额 (USD)</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              style="width: 6.5rem"
              :value="engines.betting?.amountUsd ?? 1"
              @change="onBettingAmountUsdChange"
            >
          </label>
          <label v-if="isBettingPage" class="interval-select" title="盘前/盘中列表按间隔自动刷新赛程；0=关闭">
            <span>页面刷新(秒)</span>
            <input
              type="number"
              min="0"
              max="600"
              step="1"
              style="width: 5.5rem"
              :value="engines.betting?.listPageRefreshIntervalSec ?? 0"
              @change="onListPollIntervalChange('listPageRefreshIntervalSec', $event)"
            >
          </label>
          <label v-if="isBettingPage" class="interval-select" title="列表页开启自动投注后，刷新赛程并尝试买入的间隔">
            <span>自动投注刷新(秒)</span>
            <input
              type="number"
              min="10"
              max="600"
              step="1"
              style="width: 5.5rem"
              :value="engines.betting?.listAutoBetIntervalSec ?? 60"
              @change="onListPollIntervalChange('listAutoBetIntervalSec', $event)"
            >
          </label>
          <label class="interval-select" title="列表页开启自动投注后，检查止损/卖出的间隔；调度请用「止损引擎」任务">
            <span>止损刷新(秒)</span>
            <input
              type="number"
              min="10"
              max="600"
              step="1"
              style="width: 5.5rem"
              :value="engines.betting?.listStopLossIntervalSec ?? 60"
              @change="onListPollIntervalChange('listStopLossIntervalSec', $event)"
            >
          </label>
          <span class="engines-note" style="margin:0">
            {{ isStopPage
              ? '止损组与条件引擎共用账号；保存后可在调度中心添加「止损引擎」任务'
              : '各桶打开即投注；列表轮询 10–600 秒（页面刷新可填 0 关闭），改后刷新列表页生效' }}
          </span>
        </div>

        <div class="condition-tabs" role="tablist">
          <button
            v-for="t in BETTING_TABS"
            :key="t.id"
            type="button"
            class="condition-tab"
            :class="{ on: bettingTab === t.id, enabled: bettingDraft[t.id]?.enabled }"
            role="tab"
            :aria-selected="bettingTab === t.id"
            @click="bettingTab = t.id"
          >
            {{ t.label }}
            <span class="dot" :class="{ on: bettingDraft[t.id]?.enabled }" />
          </button>
        </div>

        <div class="condition-tab-panel">
          <div class="settings-row engines-row">
            <label v-if="isBettingPage" class="collect-toggle">
              <span>{{ BETTING_TABS.find(t => t.id === bettingTab)?.label }}打开</span>
              <input
                type="checkbox"
                :checked="!!activeBettingBucket.enabled"
                @change="setBettingBucketEnabled"
              >
              <span class="toggle-state" :class="{ off: !activeBettingBucket.enabled }">{{ activeBettingBucket.enabled ? '已开启' : '已关闭' }}</span>
            </label>
            <label v-if="isBettingPage && bettingTab !== 'inplay'" class="collect-toggle" title="调度/引擎侧默认；列表用户各自打开「自动投注」才会按规则下单">
              <span>模拟投注</span>
              <input
                type="checkbox"
                :checked="!!activeBettingBucket.simulate"
                @change="setBettingBucketSimulate"
              >
              <span class="toggle-state" :class="{ off: !activeBettingBucket.simulate }">{{ activeBettingBucket.simulate ? '模拟' : '实盘' }}</span>
            </label>
            <button type="button" class="btn ghost" @click="addBettingGroup">加一组</button>
            <button type="button" class="btn primary" :disabled="bettingSaving" @click="saveBettingBucketAndEnable">
              {{ bettingSaving ? '保存中…' : '保存本桶' }}
            </button>
            <span v-if="bettingDraftDirty" class="dirty-hint">有未保存修改</span>
          </div>

          <div v-if="isBettingPage && bettingTab === 'inplay'" class="condition-group-wrap inplay-entry-panel">
            <div class="condition-group-head">
              <div class="condition-group-title">盘中自动买入条件</div>
              <div class="condition-group-hint">列表「自动投注」与调度买入共用；默认即原写死规则，可改</div>
            </div>
            <div class="condition-fields">
              <label class="collect-toggle">
                <span>须赢首盘</span>
                <input
                  type="checkbox"
                  :checked="!!activeBettingBucket.entry?.requireWonFirstSet"
                  @change="setInplayEntryField('requireWonFirstSet', $event.target.checked)"
                >
              </label>
              <label
                v-if="activeBettingBucket.entry?.requireWonFirstSet"
                class="collect-toggle"
                title="首盘局分为该比分时不买入（顺序无关，默认 7:5）"
              >
                <span>排除首盘</span>
                <input
                  type="checkbox"
                  :checked="!!activeBettingBucket.entry?.firstSetExcludeEnabled"
                  @change="setInplayEntryField('firstSetExcludeEnabled', $event.target.checked)"
                >
              </label>
              <label
                v-if="activeBettingBucket.entry?.requireWonFirstSet && activeBettingBucket.entry?.firstSetExcludeEnabled"
                title="仅排除第一盘该局分，如 7:5 / 7-5"
              >
                局分
                <input
                  type="text"
                  :value="activeBettingBucket.entry?.firstSetExcludeScore || '7:5'"
                  placeholder="7:5"
                  @change="setInplayEntryField('firstSetExcludeScore', $event.target.value)"
                >
              </label>
              <label>买入侧 PM¢&lt;
                <input
                  type="number"
                  min="1"
                  max="99"
                  :value="activeBettingBucket.entry?.pmCentsMax === 'all' || activeBettingBucket.entry?.pmCentsMax == null || activeBettingBucket.entry?.pmCentsMax === '' ? '' : activeBettingBucket.entry.pmCentsMax"
                  placeholder="不限"
                  @change="setInplayEntryField('pmCentsMax', $event.target.value)"
                >
              </label>
            </div>
          </div>

          <div
            v-for="(g, gi) in activeBettingBucket.groups"
            :key="'bet-' + (g.id || bettingTab) + '-' + gi"
            class="condition-group-wrap"
          >
            <div v-if="gi > 0 && !isStopPage" class="condition-join">
              <select
                :value="g.joinPrev || 'or'"
                @change="setBettingGroupField(gi, 'joinPrev', $event.target.value)"
              >
                <option value="or">或 OR</option>
                <option value="and">且 AND</option>
              </select>
            </div>
            <div class="condition-group-card" :class="[groupTintClass(gi), { collapsed: isBettingGroupCollapsed(gi) }]">
            <div class="condition-group-head">
              <button
                type="button"
                class="group-fold-btn"
                :aria-expanded="!isBettingGroupCollapsed(gi)"
                :title="isBettingGroupCollapsed(gi) ? '展开' : '折叠'"
                @click="toggleBettingGroup(gi)"
              >{{ isBettingGroupCollapsed(gi) ? '▸' : '▾' }}</button>
              <input
                class="group-name-input"
                type="text"
                maxlength="40"
                :value="g.name || ''"
                :placeholder="groupDisplayName(g, gi)"
                @change="setBettingGroupField(gi, 'name', $event.target.value)"
              >
              <span class="muted">止损组</span>
              <span v-if="isStopPage" class="muted sm">已挂 {{ ordersLinkedToStopGroup(g).length }} 笔</span>
              <button
                type="button"
                class="btn ghost sm"
                @click="removeBettingGroup(gi)"
              >删除</button>
            </div>
            <div v-show="!isBettingGroupCollapsed(gi)" class="condition-group-body">

            <div v-if="isStopPage" class="stop-order-link-panel">
              <label class="stop-order-pick">
                <span>挂订单</span>
                <select
                  :disabled="!!stopOrderLinkBusy"
                  @change="attachOrderToGroup($event.target.value, gi); $event.target.value = ''"
                >
                  <option value="">选择未平仓订单…</option>
                  <option
                    v-for="o in openStopOrders.filter((x) => orderBucketKey(x) === bettingTab)"
                    :key="o.id"
                    :value="o.id"
                  >{{ o.label || o.market }} · {{ o.side }}</option>
                </select>
              </label>
              <ul v-if="ordersLinkedToStopGroup(g).length" class="linked-orders-mini">
                <li v-for="o in ordersLinkedToStopGroup(g)" :key="'lnk-' + o.id">
                  {{ o.label || o.market }} · {{ o.side }}
                </li>
              </ul>
            </div>

            <div class="condition-group-section stop-section-head">
              <span>止损条件</span>
              <label class="check-inline stop-enable-inline">
                <span>启用</span>
                <input
                  type="checkbox"
                  :checked="g.stopEnabled !== false"
                  @change="setBettingGroupField(gi, 'stopEnabled', $event.target.checked)"
                >
              </label>
              <button
                type="button"
                class="btn ghost sm"
                @click="addStopRule(gi)"
              >加一条止损</button>
            </div>

            <div
              v-for="(sr, si) in ensureStopRules(g)"
              :key="'stop-' + gi + '-' + si"
              class="stop-rule-wrap"
            >
              <div v-if="si > 0" class="condition-join">
                <select
                  :value="sr.joinPrev || 'or'"
                  :disabled="g.stopEnabled === false"
                  @change="setStopRuleField(gi, si, 'joinPrev', $event.target.value)"
                >
                  <option value="or">或 OR</option>
                  <option value="and">且 AND</option>
                </select>
              </div>
              <div class="stop-rule-card" :class="{ disabled: g.stopEnabled === false }">
                <div class="condition-group-head">
                  <input
                    class="group-name-input"
                    type="text"
                    maxlength="40"
                    :value="sr.name || ''"
                    :placeholder="stopRuleDisplayName(sr, si)"
                    :disabled="g.stopEnabled === false"
                    @change="setStopRuleField(gi, si, 'name', $event.target.value)"
                  >
                  <button
                    type="button"
                    class="btn ghost sm"
                    :disabled="g.stopEnabled === false || ensureStopRules(g).length <= 1"
                    @click="removeStopRule(gi, si)"
                  >删除</button>
                </div>
                <div class="condition-group-fields">
                  <label>赛制
                    <select
                      :value="sr.stopFormat || 'any'"
                      :disabled="g.stopEnabled === false"
                      @change="setStopRuleField(gi, si, 'stopFormat', $event.target.value)"
                    >
                      <option value="any">不限</option>
                      <option value="bo3">BO3</option>
                      <option value="bo5">BO5</option>
                    </select>
                  </label>
                  <label>第几盘
                    <input
                      type="number"
                      min="1"
                      max="5"
                      :value="sr.stopSetIndex === 'all' || sr.stopSetIndex == null || sr.stopSetIndex === '' ? '' : sr.stopSetIndex"
                      placeholder="不限"
                      :disabled="g.stopEnabled === false"
                      @change="setStopRuleField(gi, si, 'stopSetIndex', $event.target.value)"
                    >
                  </label>
                  <label>强者已胜盘
                    <input
                      type="number"
                      min="0"
                      max="3"
                      :value="sr.stopStrongSets === 'all' || sr.stopStrongSets == null ? '' : sr.stopStrongSets"
                      placeholder="不限"
                      :disabled="g.stopEnabled === false"
                      @change="setStopRuleField(gi, si, 'stopStrongSets', $event.target.value)"
                    >
                  </label>
                  <label>弱者已胜盘
                    <input
                      type="number"
                      min="0"
                      max="3"
                      :value="sr.stopWeakSets === 'all' || sr.stopWeakSets == null ? '' : sr.stopWeakSets"
                      placeholder="不限"
                      :disabled="g.stopEnabled === false"
                      @change="setStopRuleField(gi, si, 'stopWeakSets', $event.target.value)"
                    >
                  </label>
                  <label>局差≥
                    <input
                      type="number"
                      min="0"
                      :value="sr.stopGameLead === 'all' || sr.stopGameLead == null || sr.stopGameLead === '' ? '' : sr.stopGameLead"
                      placeholder="不限"
                      :disabled="g.stopEnabled === false"
                      @change="setStopRuleField(gi, si, 'stopGameLead', $event.target.value)"
                    >
                  </label>
                  <label>PM¢&lt;
                    <input
                      type="number"
                      min="1"
                      max="99"
                      step="1"
                      :value="sr.stopPmCentsMax === 'all' || sr.stopPmCentsMax == null || sr.stopPmCentsMax === '' ? '' : sr.stopPmCentsMax"
                      placeholder="不限"
                      title="买入侧 Polymarket 价格(¢)小于此值则触发；与局差满足其一即可；留空或不存在赔率时不参与判断"
                      :disabled="g.stopEnabled === false"
                      @change="setStopRuleField(gi, si, 'stopPmCentsMax', $event.target.value)"
                    >
                  </label>
                </div>
              </div>
            </div>
            <p class="condition-group-hint">
              {{ isStopPage
                ? '各止损组相互隔离，仅对本组挂接的订单生效；组内可加多条止损条件，条间选且/或。调度请用「止损引擎 · 持仓止损扫描」。'
                : '组内可加多条条件，条间选且/或；未填字段表示不限制。局差与 PM 满足其一即可。调度请用「止损引擎 · 持仓止损扫描」。' }}
            </p>
            </div>
            </div>
          </div>

          <div v-if="isStopPage" class="stop-orders-panel">
            <div class="condition-group-head">
              <div class="condition-group-title">订单列表</div>
              <button type="button" class="btn ghost sm" :disabled="stopOrdersLoading" @click="loadStopOrders">
                {{ stopOrdersLoading ? '刷新中…' : '刷新' }}
              </button>
            </div>
            <p v-if="stopOrdersError" class="engines-note fail">{{ stopOrdersError }}</p>
            <p v-else class="engines-note">下单后在此挂止损组；各止损组相互隔离，仅对本组订单生效。</p>
            <div v-if="!openStopOrders.length && !stopOrdersLoading" class="engines-note muted">暂无未平仓买入订单</div>
            <table v-else class="stop-orders-table">
              <thead>
                <tr>
                  <th>场次</th>
                  <th>桶</th>
                  <th>方向</th>
                  <th>金额</th>
                  <th>止损组</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="o in openStopOrders" :key="'ord-' + o.id">
                  <td>{{ o.label || o.market }}</td>
                  <td>{{ orderBucketKey(o) === 'inplay' ? '盘中' : '盘前' }}</td>
                  <td>{{ o.side }}</td>
                  <td>{{ o.amountUsd != null ? ('$' + o.amountUsd) : '—' }}</td>
                  <td>
                    <select
                      :value="o.strategyKey || ''"
                      :disabled="stopOrderLinkBusy === o.id"
                      @change="linkOrderToStopGroup(o, $event.target.value, orderBucketKey(o))"
                    >
                      <option value="">未挂止损组</option>
                      <option
                        v-for="opt in stopGroupOptions.filter((x) => x.bucket === orderBucketKey(o))"
                        :key="opt.key"
                        :value="opt.key"
                      >{{ opt.label }}</option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        </template>
      </section>
    </div>

    <div v-if="notice" class="banner ok">{{ notice }}</div>
    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="pageBlockingLoading" class="banner">加载中…</div>

    <template v-else-if="isCollectPage">
      <details class="panel panel-fold stats-fold" :open="statsOpen" @toggle="statsOpen = $event.target.open">
        <summary class="fold-summary stats-summary">
          <span class="fold-title">运行状态</span>
          <span class="fold-inline">
            <span class="pill sm" :class="statusTone">{{ statusLabel }}</span>
            <span class="fold-meta">
              {{ fmtTime(lastRun.finished_at || lastRun.started_at) }}
              · {{ bundle.event_count ?? 0 }} 场
              · 进行中 {{ livePoll.live_count ?? liveMatches.length }}
              · Top100 {{ summary.total_matches ?? '—' }}
            </span>
          </span>
          <span class="muted fold-toggle">{{ statsOpen ? '收起' : '展开' }}</span>
        </summary>
        <div class="cards cards-compact">
          <div class="card">
            <div class="label">状态</div>
            <div class="value"><span class="pill" :class="statusTone">{{ statusLabel }}</span></div>
          </div>
          <div class="card">
            <div class="label">最近采集</div>
            <div class="value mono sm">{{ fmtTime(lastRun.finished_at || lastRun.started_at) }}</div>
          </div>
          <div class="card">
            <div class="label">Bundle</div>
            <div class="value sm">{{ bundle.event_count ?? 0 }} 场</div>
            <div class="hint">{{ bundle.date || '—' }}</div>
          </div>
          <div class="card">
            <div class="label">进行中</div>
            <div class="value sm">{{ livePoll.live_count ?? liveMatches.length }}</div>
          </div>
          <div class="card">
            <div class="label">Redis</div>
            <div class="value sm">{{ redisUpstreamLabel }}</div>
          </div>
          <div class="card">
            <div class="label">Top100</div>
            <div class="value sm">{{ summary.total_matches ?? '—' }}</div>
            <div class="hint">A{{ summary.atp_matches ?? 0 }} · W{{ summary.wta_matches ?? 0 }}</div>
          </div>
        </div>
      </details>

      <details class="panel panel-fold metrics-fold" :open="metricsOpen" @toggle="metricsOpen = $event.target.open">
        <summary class="fold-summary stats-summary">
          <span class="fold-title">采集统计</span>
          <span class="fold-meta">
            HTTP {{ collectRequests?.total ?? '—' }} 次
            · 采集 {{ formatMs(collectElapsedMs) }}
            · PM {{ formatMs(polyElapsedMs) }}
            · Redis {{ formatMs(redisRefreshStats?.totalMs) }}
          </span>
          <span class="muted fold-toggle">{{ metricsOpen ? '收起' : '展开' }}</span>
        </summary>
        <div class="metrics metrics-inner">
          <div class="metric">
            <div class="metric-label">采集 HTTP 请求</div>
            <div class="metric-value">{{ collectRequests?.total ?? '—' }} 次</div>
            <div class="metric-hint">{{ collectRequestHint(collectRequests) }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">采集耗时</div>
            <div class="metric-value">{{ formatMs(collectElapsedMs) }}</div>
            <div class="metric-hint">Top100 最近一轮</div>
          </div>
          <div class="metric">
            <div class="metric-label">Polymarket 外链</div>
            <div class="metric-value">{{ formatMs(polyElapsedMs) }}</div>
            <div class="metric-hint">
              匹配 {{ formatMs(polyMatchStats?.timingMs?.match ?? redisRefreshStats?.polyMatchMs) }}
              · 刷价 {{ formatMs(polyMatchStats?.timingMs?.prices ?? redisRefreshStats?.polyPriceMs) }}
              · 链接 {{ polyMatchStats?.matched ?? '—' }} 场
            </div>
          </div>
          <div class="metric">
            <div class="metric-label">写入 Redis 总耗时</div>
            <div class="metric-value">{{ formatMs(redisRefreshStats?.totalMs) }}</div>
            <div class="metric-hint">含 PM 外链 · {{ fmtTime(dataSource?.redis_fetched_at) }}</div>
          </div>
        </div>
      </details>

      <div class="tabs">
        <button type="button" :class="{ on: tab === 'atp' }" @click="openPoolView('atp')">ATP</button>
        <button type="button" :class="{ on: tab === 'wta' }" @click="openPoolView('wta')">WTA</button>
        <button type="button" :class="{ on: tab === 'live' }" @click="tab = 'live'">进行中</button>
        <button type="button" :class="{ on: tab === 'logs' }" @click="tab = 'logs'">日志</button>
        <button type="button" class="link" :disabled="busy || running" @click="refreshTop100">重拉 Top100</button>
      </div>

      <div v-if="tab === 'live'" class="panel">
        <div class="panel-h row">
          <span class="panel-title">进行中 · {{ livePoll.date || status?.latest_bundle?.date || '—' }}</span>
          <span class="muted panel-meta">
            <template v-if="liveRunning">拉取中…</template>
            <template v-else-if="!livePollAutoEnabled">自动拉取已关闭 · 可手动「拉取进行中」 · {{ fmtTime(livePoll.finished_at || livePoll.fetched_at) }}</template>
            <template v-else>监控每 {{ livePollIntervalLabel }} 拉取 · 页面 60 秒刷新 · {{ fmtTime(livePoll.finished_at || livePoll.fetched_at) }}</template>
          </span>
        </div>
        <div v-if="livePoll.error" class="banner err">{{ formatMonitorError(livePoll.error) }}</div>
        <div v-else-if="!liveMatches.length" class="empty">当前没有进行中的比赛</div>
        <template v-else>
          <div class="pager">
            <span class="pager-info">第 {{ livePage }} / {{ livePageCount }} 页 · {{ livePageLabel() }}</span>
            <div class="pager-actions">
              <button type="button" class="pager-btn" :disabled="livePage <= 1" @click="setLivePage(livePage - 1)">上一页</button>
              <button type="button" class="pager-btn" :disabled="livePage >= livePageCount" @click="setLivePage(livePage + 1)">下一页</button>
            </div>
          </div>
          <div class="live-list">
          <div v-for="m in pagedLiveMatches" :key="m.id" class="live-row">
            <div class="live-top">
              <span class="st live">{{ m.status || '进行中' }}</span>
            </div>
            <div class="live-players">
              <div class="live-player-line">
                <span class="live-name">{{ m.home || '—' }}</span>
                <span v-if="playerLiveScoreText(m, 'home')" class="live-player-score">{{ playerLiveScoreText(m, 'home') }}</span>
              </div>
              <span class="live-vs">VS</span>
              <div class="live-player-line">
                <span class="live-name">{{ m.away || '—' }}</span>
                <span v-if="playerLiveScoreText(m, 'away')" class="live-player-score">{{ playerLiveScoreText(m, 'away') }}</span>
              </div>
            </div>
            <div class="live-bot">
              <span>{{ (m.tournamentShort || m.tournament || '—').replace(/,.*/, '') }}</span>
              <span v-if="m.roundLabel"> · {{ m.roundLabel }}</span>
              <span> · {{ m.tour || '' }}</span>
            </div>
          </div>
          </div>
          <div class="pager pager-bottom">
            <span class="pager-info">{{ livePageLabel() }}</span>
            <div class="pager-actions">
              <button type="button" class="pager-btn" :disabled="livePage <= 1" @click="setLivePage(livePage - 1)">上一页</button>
              <button type="button" class="pager-btn" :disabled="livePage >= livePageCount" @click="setLivePage(livePage + 1)">下一页</button>
            </div>
          </div>
        </template>
      </div>

      <div v-else-if="tab === 'logs'" class="panel">
        <div class="panel-h row">
          <span>采集日志</span>
          <div class="panel-h-actions">
            <span class="muted truncate">{{ logs?.file || logs?.log_file || status?.latest_log || '—' }}</span>
            <button
              type="button"
              class="btn ghost sm danger"
              :disabled="logsClearing || !logLines.length"
              @click="clearCollectLogs"
            >{{ logsClearing ? '清空中…' : '清空' }}</button>
          </div>
        </div>
        <div class="pager">
          <span class="pager-info">第 {{ logPage }} / {{ logPageCount }} 页 · {{ logPageLabel() }}</span>
          <div class="pager-actions">
            <button type="button" class="pager-btn" :disabled="logPage <= 1" @click="setLogPage(logPage - 1)">上一页</button>
            <button type="button" class="pager-btn" :disabled="logPage >= logPageCount" @click="setLogPage(logPage + 1)">下一页</button>
          </div>
        </div>
        <pre class="log">{{ pagedLogText }}</pre>
        <div class="pager pager-bottom">
          <span class="pager-info">{{ logPageLabel() }}</span>
          <div class="pager-actions">
            <button type="button" class="pager-btn" :disabled="logPage <= 1" @click="setLogPage(logPage - 1)">上一页</button>
            <button type="button" class="pager-btn" :disabled="logPage >= logPageCount" @click="setLogPage(logPage + 1)">下一页</button>
          </div>
        </div>
      </div>
    </template>

    <Teleport to="body">
    <div v-if="poolFilterOpen" class="pool-filter-mask" @click.self="poolFilterOpen = false">
      <div class="pool-filter-panel" role="dialog" aria-modal="true" :aria-label="`${tab.toUpperCase()} 球员`">
        <header class="pool-filter-head">
          <div class="pool-filter-title">
            <div class="pool-tour-tabs">
              <button type="button" class="pool-tour-btn" :class="{ on: tab === 'atp' }" @click="tab = 'atp'">ATP</button>
              <button type="button" class="pool-tour-btn" :class="{ on: tab === 'wta' }" @click="tab = 'wta'">WTA</button>
            </div>
            <div class="pool-filter-sub">
              Top{{ topPoolMax }} · {{ top100Board?.date || '—' }}
              <span class="muted"> · {{ poolSummary.players }} 人 · {{ poolSummary.matches }} 场</span>
            </div>
          </div>
          <button type="button" class="btn ghost" @click="poolFilterOpen = false">关闭</button>
        </header>
        <div class="pool-filter-body">
          <div class="pool-filters">
            <div class="pool-bar">
              <span class="pool-label">排名池</span>
              <button type="button" class="chip-btn" :class="{ active: topPoolMax === '20' }" @click="topPoolMax = '20'">Top20</button>
              <button type="button" class="chip-btn" :class="{ active: topPoolMax === '50' }" @click="topPoolMax = '50'">Top50</button>
              <button type="button" class="chip-btn" :class="{ active: topPoolMax === '100' }" @click="topPoolMax = '100'">Top100</button>
            </div>
            <div class="pool-bar">
              <span class="pool-label">赛事</span>
              <button
                v-for="opt in TIER_OPTIONS"
                :key="opt.key"
                type="button"
                class="chip-btn"
                :class="{ active: tierFilter[opt.key] }"
                @click="toggleTier(opt.key)"
              >
                {{ opt.label }}
              </button>
            </div>
            <label class="match-only">
              <input v-model="onlyWithMatches" type="checkbox">
              <span>仅有赛事</span>
            </label>
          </div>

          <div class="pool-results">
            <div class="pool-results-meta muted">
              <template v-if="top100Board?.loading">拉取中…<span v-if="top100LoadingSec"> · 已 {{ top100LoadingSec }}s</span></template>
              <template v-else>更新 {{ fmtTime(top100Board?.fetched_at) }} · {{ poolFilterSummary }}</template>
            </div>

            <div v-if="top100Board?.error" class="banner err">{{ formatMonitorError(top100Board.error) }}</div>
            <div v-else-if="top100Board?.loading && !players.length" class="empty">
              正在拉取 Top{{ topPoolMax }}…<span v-if="top100LoadingSec">（已 {{ top100LoadingSec }} 秒，通常 1～3 分钟）</span>
            </div>
            <div v-else-if="!players.length" class="empty">
              <template v-if="rawPoolPlayers.length && (onlyWithMatches || tierFilterActive())">
                暂无符合筛选的球员（池内 {{ rawPoolPlayers.length }} 人）
                <div class="hint">可取消「仅有赛事」或调整赛事级别筛选</div>
              </template>
              <template v-else>暂无 Top{{ topPoolMax }} 球员数据</template>
            </div>

            <template v-else>
              <div class="pager">
                <span class="pager-info">第 {{ playerPage }} / {{ playerPageCount }} 页 · {{ playerPageLabel() }} · 每页 {{ PLAYER_PAGE_SIZE }} 人</span>
                <div class="pager-actions">
                  <button type="button" class="pager-btn" :disabled="playerPage <= 1" @click="setPlayerPage(playerPage - 1)">上一页</button>
                  <button type="button" class="pager-btn" :disabled="playerPage >= playerPageCount" @click="setPlayerPage(playerPage + 1)">下一页</button>
                </div>
              </div>
              <div class="plist">
                <div v-for="p in pagedPlayers" :key="p.id" class="player">
                  <button type="button" class="player-h" @click="toggle(p.id)">
                    <span class="rank">#{{ p.rank }}</span>
                    <span class="player-main">
                      <span class="name">{{ p.name }}</span>
                      <span class="meta">{{ p.country || '—' }} · {{ p.points ?? '—' }} pts</span>
                    </span>
                    <span class="mc" :class="{ hot: (p.matchCount || 0) > 0 }">{{ p.matchCount || 0 }} 场</span>
                  </button>
                  <div v-if="expanded[p.id]" class="matches">
                    <div v-if="!(p.matches || []).length" class="empty tiny">今日无比赛</div>
                    <a
                      v-for="m in p.matches || []"
                      :key="m.id"
                      class="match"
                      :href="sofaTennisMatchUrl(m)"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <div class="m-top">
                        <span class="st">{{ m.status || m.statusRaw || '—' }}</span>
                        <span>{{ m.startTime || '—' }}</span>
                      </div>
                      <div class="m-mid">
                        vs {{ m.opponent || '—' }}
                        <span v-if="m.opponentRank" class="rk">#{{ m.opponentRank }}</span>
                      </div>
                      <div class="m-bot">
                        <span>{{ m.tournament || '—' }}</span>
                        <span v-if="m.level" class="lv">{{ m.level }}</span>
                        <span>{{ m.round || '' }}</span>
                      </div>
                    </a>
                  </div>
                </div>
              </div>
              <div class="pager pager-bottom">
                <span class="pager-info">{{ playerPageLabel() }}</span>
                <div class="pager-actions">
                  <button type="button" class="pager-btn" :disabled="playerPage <= 1" @click="setPlayerPage(playerPage - 1)">上一页</button>
                  <button type="button" class="pager-btn" :disabled="playerPage >= playerPageCount" @click="setPlayerPage(playerPage + 1)">下一页</button>
                </div>
              </div>
            </template>
          </div>
        </div>
        <footer class="pool-filter-foot">
          <button type="button" class="btn primary" @click="poolFilterOpen = false">完成</button>
        </footer>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tennis-monitor { display: flex; flex-direction: column; gap: 8px; }
.toolbar {
  display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap;
}
.titles .title { font-size: 0.98rem; font-weight: 700; color: #0f172a; line-height: 1.25; }
.titles .sub { margin-top: 1px; font-size: 0.72rem; color: #94a3b8; }
.actions-primary { display: flex; gap: 6px; flex-shrink: 0; align-items: center; flex-wrap: wrap; }
.settings-row {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 8px 10px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
}
.engines-note {
  font-size: 12px;
  color: #64748b;
  margin: 0.35rem 0 0.5rem;
}
.dirty-hint {
  font-size: 11px;
  color: #d97706;
  font-weight: 600;
}
.engine-panels {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  margin-bottom: 0.75rem;
}
.engine-panel {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 0.55rem 0.65rem 0.65rem;
}
.engine-panel-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.engine-panel-head h3 {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 700;
  color: #0f172a;
}
.engine-panel-tag {
  font-size: 0.7rem;
  color: #94a3b8;
  font-weight: 600;
}
.engine-panel .settings-row {
  border: none;
  padding: 0;
  background: transparent;
}
.condition-rules-fold {
  margin: 0.5rem 0 0;
}
.condition-tabs {
  display: flex;
  gap: 6px;
  margin: 0.5rem 0 0.65rem;
  flex-wrap: wrap;
}
.condition-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  font-size: 0.82rem;
  font-weight: 700;
  color: #64748b;
  cursor: pointer;
}
.condition-tab.on {
  background: #fff;
  color: #0f172a;
  border-color: #cbd5e1;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}
.condition-tab .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
}
.condition-tab .dot.on {
  background: #10b981;
}
.condition-tab-panel {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.condition-group-card {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.55rem 0.65rem;
  background: #f8fafc;
}
.condition-group-card.group-tint-0 {
  background: #f0f7ff;
  border-color: #dbeafe;
}
.condition-group-card.group-tint-1 {
  background: #f3faf3;
  border-color: #dcfce7;
}
.condition-group-card.group-tint-2 {
  background: #fff8f0;
  border-color: #ffedd5;
}
.condition-group-card.group-tint-3 {
  background: #f8f4ff;
  border-color: #ede9fe;
}
.condition-group-card.group-tint-4 {
  background: #fff5f7;
  border-color: #ffe4e6;
}
.condition-group-card.group-tint-5 {
  background: #f0fafa;
  border-color: #ccfbf1;
}
.condition-group-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.condition-join {
  display: flex;
  justify-content: center;
  padding: 0.15rem 0;
}
.condition-join select {
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 0.75rem;
  font-weight: 700;
  color: #4338ca;
  background: #eef2ff;
  cursor: pointer;
}
.condition-group-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.45rem;
}
.condition-group-head .group-name-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 0.82rem;
  font-weight: 700;
  color: #0f172a;
  background: #fff;
}
.condition-group-head .group-name-input:focus {
  outline: none;
  border-color: #a5b4fc;
}
.group-join-select {
  flex-shrink: 0;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  padding: 4px 6px;
  font-size: 0.72rem;
  font-weight: 700;
  color: #92400e;
  background: #fff7ed;
}
.group-join-placeholder {
  flex-shrink: 0;
  font-size: 0.7rem;
  color: #64748b;
  min-width: 2rem;
}
.group-fold-btn {
  flex-shrink: 0;
  width: 1.6rem;
  height: 1.6rem;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #64748b;
  font-size: 0.75rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.group-fold-btn:hover {
  background: #f1f5f9;
  color: #334155;
}
.condition-group-card.collapsed {
  padding-bottom: 0.45rem;
}
.condition-group-body {
  margin-top: 0.15rem;
}
.condition-group-head .muted {
  font-size: 0.72rem;
  color: #94a3b8;
  flex: 1;
}
.condition-group-fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
  gap: 0.4rem 0.65rem;
}
.condition-group-fields label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 0.72rem;
  color: #64748b;
  font-weight: 600;
}
.condition-group-fields select,
.condition-group-fields input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 0.8rem;
  font-weight: 600;
  color: #334155;
  background: #fff;
}
.condition-group-hint {
  margin: 0.4rem 0 0;
  font-size: 0.7rem;
  color: #94a3b8;
}
.condition-group-section {
  margin: 0.45rem 0 0.3rem;
  font-size: 0.75rem;
  font-weight: 700;
  color: #475569;
}
.stop-section-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.stop-enable-inline {
  margin-left: auto;
}
.stop-rule-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.35rem;
}
.stop-rule-card {
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  padding: 0.45rem 0.55rem;
  background: #fff;
}
.stop-rule-card.disabled {
  opacity: 0.55;
}
.condition-group-fields .check-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.condition-group-fields .first-set-row {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem 1rem;
}
.condition-group-fields .first-set-row .check-inline {
  flex: 0 0 auto;
  justify-content: flex-start;
  gap: 0.4rem;
}
.condition-group-fields .first-set-row .first-set-score {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  margin: 0;
}
.condition-group-fields .first-set-row .first-set-score input {
  width: 4.5rem;
}
.condition-group-fields .strong-rank-row {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.5rem;
}
.condition-group-fields .rank-diff-row {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem 1rem;
}
.condition-group-fields .rank-diff-row .rank-diff-inline {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
}
.condition-group-fields .rank-diff-row .rank-diff-inline input {
  width: 4.5rem;
}
.condition-group-fields .strong-rank-row .strong-rank-inline {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
}
.condition-group-fields .strong-rank-row .strong-rank-inline input {
  width: 4.5rem;
}
.condition-group-fields .strong-rank-row .strong-rank-and {
  font-size: 0.78rem;
  font-weight: 700;
  color: #64748b;
  white-space: nowrap;
}
.condition-group-fields .sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
/* 投注引擎买入条件：紧凑横排 */
.betting-buy-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.55rem;
}
.betting-buy-fields .bf-field {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.25rem;
  margin: 0;
  font-size: 0.72rem;
  color: #64748b;
  font-weight: 600;
}
.betting-buy-fields .bf-field select,
.betting-buy-fields .bf-field input,
.betting-buy-fields .bf-inline input,
.betting-buy-fields .bf-score {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 0.78rem;
  font-weight: 600;
  color: #334155;
  background: #fff;
  width: 4.25rem;
}
.betting-buy-fields .bf-field select {
  width: 5rem;
}
.betting-buy-fields .bf-pair {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: nowrap;
}
.betting-buy-fields .bf-inline {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 0.2rem;
  margin: 0;
  font-size: 0.72rem;
  color: #64748b;
  font-weight: 600;
}
.betting-buy-fields .bf-mid {
  font-size: 0.72rem;
  font-weight: 700;
  color: #64748b;
  white-space: nowrap;
}
.betting-buy-fields .bf-checks {
  gap: 0.55rem;
}
.betting-buy-fields .bf-check {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 0.3rem;
  margin: 0;
  font-size: 0.72rem;
  color: #64748b;
  font-weight: 600;
}
.betting-buy-fields .bf-score {
  width: 4.5rem;
}
.btn.sm {
  padding: 4px 8px;
  font-size: 0.72rem;
}
.condition-rules-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem;
  padding: 0.5rem 0.75rem 0.75rem;
}
.condition-rules-block h4 {
  margin: 0 0 0.4rem;
  font-size: 13px;
  font-weight: 600;
}
.condition-rules-block label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 12px;
  margin-bottom: 0.35rem;
}
.condition-rules-block select {
  min-width: 5.5rem;
}
.source-group {
  display: flex; align-items: center; gap: 4px;
  padding: 3px; border-radius: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;
}
.source-label {
  padding: 0 6px; font-size: 0.72rem; font-weight: 700; color: #64748b; white-space: nowrap;
}
.source-opt {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 10px; border-radius: 8px; font-size: 0.78rem; font-weight: 700;
  color: #64748b; cursor: pointer; user-select: none;
}
.source-opt input { accent-color: #4f46e5; }
.source-opt.on { background: #fff; color: #4f46e5; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08); }
.source-opt.disabled { opacity: .45; cursor: not-allowed; }
.interval-select {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.75rem; color: #64748b; font-weight: 600;
}
.interval-select select {
  border: 1px solid #cbd5e1; border-radius: 8px;
  padding: 7px 10px; font-size: 0.8rem; font-weight: 600;
  color: #334155; background: #fff; cursor: pointer;
}
.interval-select select:disabled { opacity: .55; cursor: not-allowed; }
.collect-toggle {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 10px;
  border: 1px solid var(--line, #e2e8f0); background: #fff;
  font-size: 0.82rem; color: #475569;
}
.collect-toggle input { width: 16px; height: 16px; accent-color: #4f46e5; }
.toggle-state { font-weight: 600; color: #059669; }
.toggle-state.off { color: #94a3b8; }
.live-interval-hint {
  font-size: 0.82rem;
  color: #64748b;
  white-space: nowrap;
}
.btn {
  border: 0; border-radius: 8px; padding: 7px 11px; font-size: 0.78rem; font-weight: 600;
  cursor: pointer; transition: .15s;
}
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.ghost { background: #e2e8f0; color: #334155; }
.btn.ghost.danger { background: #fee2e2; color: #b91c1c; }
.btn.ghost.danger:hover:not(:disabled) { background: #fecaca; }
.btn.primary { background: #4f46e5; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #4338ca; }

.banner {
  border-radius: 10px; padding: 8px 10px; font-size: 0.78rem;
  background: #f1f5f9; color: #475569;
}
.banner.err { background: #fef2f2; color: #b91c1c; }
.banner.ok { background: #ecfdf5; color: #047857; }

.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cards-compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.card {
  background: #fafbfc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px;
}
.cards-compact .card { padding: 8px 10px; }
.metrics-inner {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px;
}
.metric {
  padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fafbfc;
}
.metric-label { font-size: 0.68rem; color: #94a3b8; font-weight: 700; }
.metric-value { margin-top: 2px; font-size: 0.92rem; font-weight: 800; color: #0f172a; }
.metric-hint { margin-top: 2px; font-size: 0.68rem; color: #64748b; line-height: 1.3; }
.card .label { font-size: 0.68rem; color: #94a3b8; }
.card .value { margin-top: 2px; font-size: 0.92rem; font-weight: 700; color: #0f172a; }
.card .value.sm { font-size: 0.86rem; }
.card .value.mono { font-size: 0.82rem; font-weight: 600; }
.card .hint { margin-top: 2px; font-size: 0.68rem; color: #64748b; line-height: 1.3; }

.pill {
  display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 0.74rem; font-weight: 700;
}
.pill.sm { font-size: 0.68rem; padding: 1px 6px; }
.pill.run { background: #fff7ed; color: #c2410c; }
.pill.ok { background: #ecfdf5; color: #047857; }
.pill.err { background: #fef2f2; color: #b91c1c; }
.pill.idle { background: #f1f5f9; color: #475569; }

.panel {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 8px 10px;
}
.panel-fold { padding-top: 6px; padding-bottom: 6px; }
.stats-fold[open], .metrics-fold[open] { padding-bottom: 10px; }
.fold-summary {
  cursor: pointer; list-style: none; margin-bottom: 0;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
  font-size: 0.78rem; font-weight: 700; color: #334155;
}
.stats-summary { padding: 2px 0; }
.fold-summary::-webkit-details-marker { display: none; }
.panel-fold[open] .fold-summary { margin-bottom: 8px; }
.fold-title { flex: 0 0 auto; color: #475569; }
.fold-inline { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
.fold-meta {
  flex: 1 1 auto; min-width: 0;
  font-size: 0.72rem; font-weight: 600; color: #64748b;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fold-toggle { flex: 0 0 auto; font-size: 0.68rem; font-weight: 600; }
.panel-h { font-size: 0.82rem; font-weight: 700; color: #334155; margin-bottom: 8px; }
.panel-h-actions {
  display: flex; align-items: center; gap: 8px; min-width: 0; margin-left: auto;
}
.panel-h.row {
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 10px;
  align-items: baseline;
}
.panel-title { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.panel-meta { flex: 0 1 auto; min-width: 0; text-align: right; }
.muted { color: #94a3b8; font-weight: 500; font-size: 0.72rem; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.cron-list { display: flex; flex-direction: column; gap: 6px; }
.cron-list code {
  display: block; background: #0f172a; color: #e2e8f0; border-radius: 8px;
  padding: 8px 10px; font-size: 0.72rem; overflow-x: auto;
}

.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tabs button {
  border: 0; background: #e2e8f0; color: #475569; border-radius: 999px;
  padding: 6px 12px; font-size: 0.78rem; font-weight: 600; cursor: pointer;
}
.tabs button.on { background: #4f46e5; color: #fff; }
.tabs .link { background: transparent; color: #4f46e5; padding-inline: 8px; }
.tabs .link:disabled { opacity: .45; cursor: not-allowed; }

.pool-bar {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  padding: 0 2px;
}
.pool-filter-mask {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: flex-start; justify-content: center;
  padding: max(12px, env(safe-area-inset-top, 0px)) 16px max(12px, env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.pool-filter-panel {
  width: min(720px, calc(100vw - 32px));
  max-height: min(
    860px,
    calc(
      100dvh
      - max(12px, env(safe-area-inset-top, 0px))
      - max(12px, env(safe-area-inset-bottom, 0px))
      - 8px
    )
  );
  background: #fff; border-radius: 14px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.2); overflow: hidden;
  display: flex; flex-direction: column;
  flex-shrink: 0;
  margin: auto 0;
}
.pool-filter-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;
}
.pool-filter-title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pool-filter-sub { font-size: 0.72rem; color: #64748b; font-weight: 600; }
.pool-tour-tabs { display: flex; gap: 6px; }
.pool-tour-btn {
  border: 1px solid #e2e8f0; background: #f8fafc; color: #64748b;
  border-radius: 999px; padding: 4px 12px; font-size: 0.78rem; font-weight: 700; cursor: pointer;
}
.pool-tour-btn.on { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.pool-filter-body {
  display: flex; flex-direction: column; gap: 12px; padding: 14px;
  overflow: auto; flex: 1 1 auto; min-height: 0;
}
.pool-filters {
  display: flex; flex-direction: column; gap: 10px;
  padding-bottom: 12px; border-bottom: 1px solid #e2e8f0;
}
.pool-results { display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.pool-results-meta { font-size: 0.72rem; font-weight: 600; }
.pool-filter-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 14px 14px; border-top: 1px solid #e2e8f0; flex-shrink: 0;
}
.pool-label { font-size: 0.72rem; font-weight: 700; color: #94a3b8; margin-right: 2px; white-space: nowrap; }
.pool-meta { margin-left: auto; font-size: 0.72rem; color: #64748b; font-weight: 600; text-align: right; }
.match-only {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 0.76rem; font-weight: 600; color: #475569; cursor: pointer; user-select: none;
}
.match-only input { accent-color: #4f46e5; }
.chip-btn {
  border: 1px solid #cbd5e1; background: #fff; color: #64748b;
  border-radius: 999px; padding: 5px 11px; font-size: 0.76rem; font-weight: 600; cursor: pointer;
}
.chip-btn.active {
  color: #4f46e5; background: #eef2ff; border-color: #c7d2fe;
}

.plist { display: flex; flex-direction: column; gap: 6px; }
.pager {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 6px 2px; margin-bottom: 8px;
}
.pager-bottom { margin-bottom: 0; margin-top: 8px; }
.pager-info { font-size: 0.72rem; color: #64748b; font-weight: 600; }
.pager-actions { display: flex; gap: 6px; }
.pager-btn {
  border: 1px solid #cbd5e1; background: #fff; color: #475569;
  border-radius: 8px; padding: 5px 10px; font-size: 0.76rem; font-weight: 600; cursor: pointer;
}
.pager-btn:disabled { opacity: .45; cursor: not-allowed; }
.pager-btn:not(:disabled):hover { border-color: #a5b4fc; color: #4f46e5; }
.player { border: 1px solid #e2e8f0; border-radius: 12px; background: #fafbfc; }
.player-h {
  width: 100%; display: flex; gap: 8px; align-items: flex-start;
  text-align: left; border: 0; background: transparent;
  padding: 10px; cursor: pointer;
}
.rank {
  flex: 0 0 34px; font-weight: 800; color: #4f46e5; font-size: 0.82rem; line-height: 1.35;
}
.player-main {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px;
}
.name {
  font-weight: 700; color: #0f172a; font-size: 0.86rem; line-height: 1.35;
  word-break: break-word;
}
.meta {
  color: #94a3b8; font-size: 0.72rem; line-height: 1.35;
  word-break: break-word;
}
.mc {
  flex: 0 0 auto; align-self: flex-start; margin-top: 1px;
  font-size: 0.72rem; font-weight: 700; color: #64748b;
  background: #e2e8f0; border-radius: 999px; padding: 2px 8px; white-space: nowrap;
}
.mc.hot { background: #dbeafe; color: #1d4ed8; }

.matches { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.match {
  display: block; text-decoration: none; color: inherit;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px;
}
.match:hover { border-color: #a5b4fc; }
.m-top, .m-bot {
  display: flex; justify-content: space-between; gap: 8px; font-size: 0.72rem; color: #64748b;
  flex-wrap: wrap;
}
.m-bot span:first-child { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.lv {
  flex: 0 0 auto; font-size: 0.68rem; font-weight: 700; color: #6d28d9;
  background: #f5f3ff; border-radius: 999px; padding: 1px 6px;
}
.m-mid { margin: 4px 0; font-size: 0.84rem; font-weight: 600; color: #0f172a; word-break: break-word; }
.st { font-weight: 700; color: #b45309; }
.rk { margin-left: 6px; color: #94a3b8; font-weight: 500; font-size: 0.75rem; }

.live-list { display: flex; flex-direction: column; gap: 8px; }
.live-row {
  border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 12px; background: #fafbfc;
}
.live-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.live-top .st.live { color: #b91c1c; font-weight: 700; font-size: 0.75rem; }
.live-players { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
.live-player-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.live-name { font-weight: 700; font-size: 0.88rem; color: #0f172a; min-width: 0; }
.live-player-score { flex: 0 0 auto; font-weight: 800; font-size: 0.82rem; color: #0f172a; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
.live-vs { align-self: center; font-size: 0.68rem; font-weight: 700; color: #94a3b8; }
.live-bot { margin-top: 4px; font-size: 0.72rem; color: #64748b; }

.empty { text-align: center; color: #94a3b8; font-size: 0.82rem; padding: 18px 8px; }
.empty.tiny { padding: 8px; font-size: 0.75rem; }

.log {
  margin: 0; background: #0f172a; color: #e2e8f0; border-radius: 10px;
  padding: 12px; font-size: 0.72rem; line-height: 1.45; min-height: 240px;
  max-height: 42vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
}

.stop-orders-panel {
  margin-top: 16px; padding-top: 12px; border-top: 1px dashed #e2e8f0;
}
.stop-orders-table {
  width: 100%; border-collapse: collapse; font-size: 0.78rem;
}
.stop-orders-table th,
.stop-orders-table td {
  border-bottom: 1px solid #e2e8f0; padding: 8px 6px; text-align: left; vertical-align: middle;
}
.stop-orders-table select { max-width: 12rem; font-size: 0.76rem; }
.stop-order-link-panel {
  display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-start;
  margin-bottom: 10px; padding: 8px 10px; background: #f8fafc; border-radius: 8px;
}
.stop-order-pick { display: flex; flex-direction: column; gap: 4px; font-size: 0.76rem; }
.linked-orders-mini {
  margin: 0; padding-left: 1rem; font-size: 0.74rem; color: #475569;
}

@media (max-width: 720px) {
  .cards-compact { grid-template-columns: 1fr 1fr; }
  .metrics-inner { grid-template-columns: 1fr; }
  .fold-meta { white-space: normal; }
  .settings-row, .actions-primary { width: 100%; }
}
</style>
