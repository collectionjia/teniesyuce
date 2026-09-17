<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import * as api from '../api'
import {
  applyPrematchFilters,
  applyInplayFilters,
  rankMetrics,
  filterMatchesByConditionGroups,
} from '../utils/tennisListFilters'
import TennisStrategySettings from './TennisStrategySettings.vue'
import TennisStrategyList from './TennisStrategyList.vue'
import WalletSettings from './WalletSettings.vue'

defineProps({
  standalone: { type: Boolean, default: false },
})

const bundle = ref(null)
const loading = ref(false)
const error = ref('')
const filtersOpen = ref(false)
const tourFilter = ref('all')
const statusFilter = ref('all')
const pmFilter = ref('all')
const gapMin = ref('all')
const rankDiffMax = ref('all')
const strongRankMax = ref('all')
const gapMode = ref('all') // all | tier
const levelFilter = ref('all') // all | gs | 1000 | 500 | 250 | other
const query = ref('')
const autoRefresh = ref(true)
const columnsOpen = ref(false)
const COL_STORAGE_KEY = 'yuce.top100.wide.columns.v2'
const COLUMN_DEFS = [
  { key: 'timeBj', label: '北京时间', locked: false },
  { key: 'status', label: '状态', locked: false },
  { key: 'tour', label: '巡回', locked: false },
  { key: 'level', label: '级别', locked: false },
  { key: 'tourney', label: '赛事', locked: false },
  { key: 'round', label: '轮次', locked: false },
  { key: 'home', label: '主', locked: false },
  { key: 'away', label: '客', locked: false },
  { key: 'side', label: '建议', locked: false },
  { key: 'gap', label: '现差', locked: false },
  { key: 'rankDiff', label: '历史最高排位差', locked: false },
  { key: 'strong', label: '强现', locked: false },
  { key: 'score', label: '比分', locked: false },
  { key: 'odds', label: '赔率', locked: false },
  { key: 'poly', label: 'Polymarket', locked: false },
  { key: 'link', label: '链接', locked: false },
]
const DEFAULT_COLS = Object.fromEntries(COLUMN_DEFS.map((c) => [c.key, true]))

function loadColumnPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(COL_STORAGE_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_COLS }
    return { ...DEFAULT_COLS, ...raw }
  } catch {
    return { ...DEFAULT_COLS }
  }
}

const colVisible = ref(loadColumnPrefs())

function colOn(key) {
  return colVisible.value[key] !== false
}

function toggleCol(key) {
  colVisible.value = { ...colVisible.value, [key]: !colOn(key) }
  try {
    localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(colVisible.value))
  } catch (_) { /* ignore */ }
}

function showAllCols() {
  colVisible.value = { ...DEFAULT_COLS }
  try {
    localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(colVisible.value))
  } catch (_) { /* ignore */ }
}

const visibleColCount = computed(() => 1 + COLUMN_DEFS.filter((c) => colOn(c.key)).length)
let pollTimer = null

/** H5 投注引擎策略（开赛前 / 比赛中） */
const bettingBuckets = ref({ prematch: null, inplay: null })
const activeGroupKey = ref('') // prematch:id | inplay:id
const batchAmountUsd = ref('1')
const selectedIds = ref(new Set())
/** 用户从已选里手动删掉的场次，采集刷新时不再自动加回（保存/打开策略时清空） */
const autoSelectSkipIds = ref(new Set())
const conditionSelectCfg = ref({
  auto: true,
  prematchOn: false,
  inplayOn: false,
  prematchGroups: [],
  inplayGroups: [],
})
const batchSubmitting = ref(false)
const batchNotice = ref('')
const batchError = ref('')
/** 本会话已自动下单成功的「策略+场次」，避免同策略重复下单；其它策略仍可下同一场 */
const autoBetDoneIds = ref(new Set())

function autoBetDoneKey(strategyKey, eventId) {
  const sk = String(strategyKey || '').trim() || '_'
  return `${sk}::${String(eventId)}`
}
const strategySettingsOpen = ref(false)
const strategyListOpen = ref(false)
/** 当前编辑的独立策略（新建/点进列表时设置） */
const focusStrategy = ref(null)

const ordersOpen = ref(false)
const ordersLoading = ref(false)
const ordersError = ref('')
const orders = ref([])
const ordersTotal = ref(0)
const ordersAccount = ref('')
const ordersBusyId = ref(null)
const ordersClearing = ref(false)

async function openOrders() {
  ordersOpen.value = true
  await loadOrders()
}

async function loadOrders() {
  ordersLoading.value = true
  ordersError.value = ''
  try {
    const data = await api.fetchTennisBettingOrders({ limit: 100 })
    orders.value = Array.isArray(data?.items) ? data.items : []
    ordersTotal.value = Number(data?.total) || orders.value.length
    ordersAccount.value = data?.userAccount ? String(data.userAccount) : ''
  } catch (e) {
    ordersError.value = e?.response?.data?.error || e?.message || '加载订单失败'
    orders.value = []
  } finally {
    ordersLoading.value = false
  }
}

async function removeOrder(row) {
  if (!row?.id) return
  if (!confirm('确认删除这条订单记录？')) return
  ordersBusyId.value = row.id
  ordersError.value = ''
  try {
    await api.deleteTennisBettingOrder(row.id)
    orders.value = orders.value.filter((x) => x.id !== row.id)
    ordersTotal.value = Math.max(0, (Number(ordersTotal.value) || 0) - 1)
  } catch (e) {
    ordersError.value = e?.response?.data?.error || e?.message || '删除失败'
  } finally {
    ordersBusyId.value = null
  }
}

async function clearOrders() {
  if (!orders.value.length) return
  if (!confirm('确认清空全部网球订单记录？此操作不可恢复。')) return
  ordersClearing.value = true
  ordersError.value = ''
  try {
    await api.clearTennisBettingOrders()
    orders.value = []
    ordersTotal.value = 0
  } catch (e) {
    ordersError.value = e?.response?.data?.error || e?.message || '清空失败'
  } finally {
    ordersClearing.value = false
  }
}

function fmtOrderAt(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function orderProductLabel(p) {
  if (p === 'tennis-prematch' || p === 'tennis-range' || p === 'tennis-new' || p === 'tennis') return '开赛前'
  if (p === 'tennis-inplay' || p === 'tennis-live') return '比赛中'
  if (p === 'tennis-settled' || p === 'tennis-post') return '已完赛'
  return p || '—'
}

function orderSideLabel(side) {
  const s = String(side || '').toLowerCase()
  if (s === 'home') return '主'
  if (s === 'away') return '客'
  return s ? s.toUpperCase() : ''
}

function orderAmountTxt(row) {
  if (row.action === 'sell' && row.shares != null) {
    const sh = Number(row.shares)
    const px = Number(row.price)
    if (px > 0) return `${sh.toFixed(2)}份 @ ${px.toFixed(3)}`
    return `${sh.toFixed(2)}份`
  }
  const parts = []
  if (row.amountUsd != null && Number.isFinite(Number(row.amountUsd))) {
    parts.push(`$${Number(row.amountUsd)}`)
  }
  if (row.price != null && Number.isFinite(Number(row.price))) {
    parts.push(`@ ${Number(row.price).toFixed(3)}`)
  }
  return parts.length ? parts.join(' ') : '—'
}

function shortOrderId(id) {
  const s = String(id || '')
  if (!s) return ''
  if (s.length <= 14) return s
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function orderIsSim(row) {
  const label = String(row?.label || '')
  const oid = String(row?.orderId || '')
  return label.includes('[模拟]') || oid.startsWith('sim_')
}

/** market::side → 该侧最新成功卖出单 id，避免模板里 O(n²) 扫单 */
const soldMaxIdByMarketSide = computed(() => {
  const map = new Map()
  for (const x of orders.value) {
    if (!x || x.action !== 'sell' || x.ok === false) continue
    const k = `${String(x.market || '')}::${String(x.side || '').toLowerCase()}`
    const id = Number(x.id)
    if (!Number.isFinite(id)) continue
    const prev = map.get(k)
    if (prev == null || id > prev) map.set(k, id)
  }
  return map
})

function orderAlreadySold(row) {
  const market = String(row?.market || '')
  const side = String(row?.side || '').toLowerCase()
  if (!market || !side) return false
  const maxId = soldMaxIdByMarketSide.value.get(`${market}::${side}`)
  return maxId != null && maxId > Number(row.id)
}

function canSellOrder(row) {
  if (!row || row.ok === false || row.action === 'sell') return false
  const market = String(row.market || '')
  const side = String(row.side || '').toLowerCase()
  if (!market || !['home', 'away'].includes(side)) return false
  if (orderAlreadySold(row)) return false
  return true
}

function orderProductKey(row) {
  const p = String(row?.product || '').toLowerCase()
  if (p.includes('inplay') || p.includes('live')) return 'tennis-inplay'
  return 'tennis-prematch'
}

async function sellOrder(row) {
  if (!canSellOrder(row) || ordersBusyId.value) return
  const eventId = String(row.market)
  const side = String(row.side).toLowerCase()
  const sim = orderIsSim(row)
  if (!confirm(`确认卖出${sim ? '（模拟）' : ''}（全部持仓）？\n${row.label || eventId}`)) return
  ordersBusyId.value = row.id
  ordersError.value = ''
  try {
    const payload = { eventId, side, shares: 'all', simulate: sim }
    const product = orderProductKey(row)
    if (product === 'tennis-inplay') {
      await api.placeTennisInplaySell(payload)
    } else {
      await api.placeTennisPrematchSell(payload)
    }
    const sk = String(focusStrategy.value?.strategyKey || activeStrategy.value?.strategyKey || '').trim()
    api.markTennisBettingSold({
      product,
      strategyKey: sk || undefined,
      orders: [{ eventId, shares: 'all', soldAll: true }],
    }).catch(() => {})
    await loadOrders()
  } catch (e) {
    ordersError.value = e?.response?.data?.error || e?.message || '卖出失败'
  } finally {
    ordersBusyId.value = null
  }
}

const canShowWallet = ref(false)
const showWalletSettings = ref(false)
const walletConfigured = ref(false)
const walletUsdcBalance = ref(null)

function fmtWalletUsdc(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function loadWalletHeader() {
  try {
    // 不再重复 /auth/me：有 JWT 直接探钱包；失败则隐藏入口
    const quick = await api.fetchBtcWallet({ balance: false })
    canShowWallet.value = true
    walletConfigured.value = !!quick.configured
    if (walletConfigured.value) {
      api.fetchBtcWallet()
        .then((w) => {
          if (w?.usdcBalance != null && w.usdcBalance !== '') {
            walletUsdcBalance.value = Number(w.usdcBalance)
          }
        })
        .catch(() => { /* 余额保持 — */ })
    }
  } catch {
    canShowWallet.value = false
    walletConfigured.value = false
    walletUsdcBalance.value = null
  }
}

function onWalletUpdated(s) {
  walletConfigured.value = !!s?.configured
  if (!s?.configured) {
    walletUsdcBalance.value = null
    return
  }
  if (s.usdcBalance != null && s.usdcBalance !== '') {
    walletUsdcBalance.value = Number(s.usdcBalance)
  } else {
    // 换钱包保存瞬间会先清空余额，立刻重拉新地址
    walletUsdcBalance.value = null
    loadWalletHeader()
  }
}

const allStrategyOptions = computed(() => {
  const out = []
  for (const bucket of ['prematch', 'inplay']) {
    const b = bettingBuckets.value?.[bucket]
    const groups = Array.isArray(b?.groups) ? b.groups : []
    groups.forEach((g, i) => {
      const id = g.id || `g_${bucket}_${i}`
      const name = String(g.name || '').trim() || `策略组 ${i + 1}`
      const tag = bucket === 'inplay' ? '比赛中' : '开赛前'
      out.push({
        key: `${bucket}:${id}`,
        bucket,
        id: String(id),
        name,
        strategyKey: String(g.strategyKey || '').trim(),
        amountUsd: Number(g.amountUsd) >= 1 ? Number(g.amountUsd) : 1,
        label: `${tag} · ${name} · $${Number(g.amountUsd) >= 1 ? g.amountUsd : 1}`,
        enabled: !!b?.enabled,
        simulate: !!b?.simulate,
      })
    })
  }
  return out
})

const activeStrategy = computed(() => {
  const list = allStrategyOptions.value
  if (!list.length) return null
  return list.find((o) => o.key === activeGroupKey.value) || list[0]
})

const strategySummary = computed(() => {
  const g = activeStrategy.value
  if (!g) return '未加载策略'
  return [
    g.bucket === 'inplay' ? '比赛中' : '开赛前',
    g.enabled ? '开' : '关',
    g.bucket === 'prematch' ? (g.simulate ? '模拟' : '实盘') : null,
    g.label,
  ].filter(Boolean).join(' · ')
})

function flattenEvents(b) {
  const out = []
  const tours = b?.scheduled?.tournaments
  if (Array.isArray(tours)) {
    for (const t of tours) {
      const list = Array.isArray(t?.events) ? t.events : []
      for (const e of list) {
        if (!e || e.id == null) continue
        out.push({
          ...e,
          tournamentName: e.tournament || e.tournamentShort || t.name || t.tournament || '—',
        })
      }
    }
  }
  if (!out.length && Array.isArray(b?.live)) {
    for (const e of b.live) {
      if (e?.id != null) out.push(e)
    }
  }
  return out
}

function playerName(side, m) {
  if (side === 'home') {
    return m.homePlayer?.name || m.home?.name || (typeof m.home === 'string' ? m.home : '—')
  }
  return m.awayPlayer?.name || m.away?.name || (typeof m.away === 'string' ? m.away : '—')
}

function playerAge(side, m) {
  const player = side === 'home' ? (m.homePlayer || m.home) : (m.awayPlayer || m.away)
  if (!player || typeof player === 'string') return null
  const year = 2026
  const pid = player?.id ?? player?.teamId
  const fromMap = pid != null
    ? (bundle.value?.birthYearByPlayer?.[String(pid)] ?? bundle.value?.birthYearByPlayer?.[pid])
    : null
  const birthYear = player?.birthYear ?? fromMap
  let age = null
  if (birthYear != null && birthYear !== '') age = year - Number(birthYear)
  else if (player?.age != null && player.age !== '') age = Math.floor(Number(player.age))
  if (!Number.isFinite(age) || age <= 0) return null
  return age
}

function playerRank(side, m) {
  const p = side === 'home' ? m.homePlayer : m.awayPlayer
  const r = p?.rank ?? p?.ranking ?? (side === 'home' ? m.homeRank : m.awayRank)
  const rankings = bundle.value?.rankingsByPlayer || {}
  const id = p?.id ?? p?.teamId
  const fromMap = id != null ? (rankings[String(id)] || rankings[id]) : null
  const n = Number(fromMap?.current ?? r)
  return Number.isFinite(n) && n > 0 ? n : null
}

function playerBest(side, m) {
  const p = side === 'home' ? m.homePlayer : m.awayPlayer
  const rankings = bundle.value?.rankingsByPlayer || {}
  const id = p?.id ?? p?.teamId
  const fromMap = id != null ? (rankings[String(id)] || rankings[id]) : null
  const n = Number(fromMap?.best ?? p?.bestRank ?? p?.best)
  return Number.isFinite(n) && n > 0 ? n : null
}

function oddsPair(m) {
  const ft = m.odds?.full_time
  if (ft?.home?.decimal != null && ft?.away?.decimal != null) {
    return `${Number(ft.home.decimal).toFixed(2)} / ${Number(ft.away.decimal).toFixed(2)}`
  }
  const label = String(m.oddsLabel || '').trim()
  if (!label || label === '—' || label === '-') return '—'
  return label
}

function hasOdds(m) {
  return oddsPair(m) !== '—'
}

function polyPair(m) {
  const pm = m.polymarket
  if (pm?.home_price != null && pm?.away_price != null) {
    return `${Number(pm.home_price).toFixed(3)} / ${Number(pm.away_price).toFixed(3)}`
  }
  return m.polymarketLabel || '—'
}

function statusBucket(m) {
  // 无赔率（显示 —）视为赛事已结束
  if (!hasOdds(m)) return 'finished'
  const st = String(m.statusType || m.status || '').toLowerCase()
  if (/inprogress|live|interrupted|进行/.test(st)) return 'live'
  if (/finished|ended|完/.test(st)) return 'finished'
  return 'upcoming'
}

function statusLabel(m) {
  const b = statusBucket(m)
  if (b === 'live') return '比赛中'
  if (b === 'finished') return '完赛'
  return '未开赛'
}

function matchLevelKey(m) {
  const raw = `${m.level || ''} ${m.tournament || ''} ${m.tournamentName || ''}`.toLowerCase()
  if (/grand\s*slam|大满贯|australian open|roland garros|wimbledon|us open/.test(raw)) return 'gs'
  if (/1000|masters/.test(raw)) return '1000'
  if (/500/.test(raw)) return '500'
  if (/250/.test(raw)) return '250'
  return 'other'
}

function metricsOf(m) {
  return rankMetrics(m, bundle.value?.rankingsByPlayer || {})
}

/** 历史最高排位差：强现 − 弱者史高 = 结果 */
function rankDiffText(m) {
  const mx = metricsOf(m)
  if (!mx.ready || mx.strongRank == null || mx.weakBest == null || mx.rankDiff == null) return '—'
  return `${mx.strongRank}−${mx.weakBest}=${mx.rankDiff}`
}

/** 北京时间 */
function fmtBeijingTime(m) {
  const ts = Number(m?.startTimestamp)
  if (!(Number.isFinite(ts) && ts > 0)) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(/\//g, '-')
}

function resetFilters() {
  tourFilter.value = 'all'
  statusFilter.value = 'all'
  pmFilter.value = 'all'
  gapMin.value = 'all'
  rankDiffMax.value = 'all'
  strongRankMax.value = 'all'
  gapMode.value = 'all'
  levelFilter.value = 'all'
  query.value = ''
}

const allMatches = computed(() => flattenEvents(bundle.value))

const filterCtx = computed(() => ({
  rankingsByPlayer: bundle.value?.rankingsByPlayer || {},
  polymarketByEvent: bundle.value?.polymarketByEvent || {},
}))

const matches = computed(() => {
  const ctx = filterCtx.value
  let list = allMatches.value

  if (statusFilter.value !== 'all') {
    list = list.filter((m) => statusBucket(m) === statusFilter.value)
  }
  if (levelFilter.value !== 'all') {
    list = list.filter((m) => matchLevelKey(m) === levelFilter.value)
  }

  list = applyPrematchFilters(list, {
    tour: tourFilter.value,
    pm: pmFilter.value,
    gapMin: gapMin.value,
    rankDiffMax: rankDiffMax.value,
    strongRankMax: strongRankMax.value,
  }, ctx)

  if (gapMode.value === 'tier') {
    list = applyInplayFilters(list, {
      tour: 'all',
      pm: 'all',
      strongRankMax: 'all',
      gapMode: 'tier',
    }, ctx)
  }

  const q = query.value.trim().toLowerCase()
  if (q) {
    list = list.filter((m) => {
      const hay = [
        playerName('home', m),
        playerName('away', m),
        m.tournamentName,
        m.tournament,
        m.level,
        m.roundLabel,
      ].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }

  return [...list].sort((a, b) => {
    const ta = Number(a.startTimestamp) || 0
    const tb = Number(b.startTimestamp) || 0
    return ta - tb
  })
})

/** 行展示字段预计算，避免模板里反复 pickSide/metricsOf */
const matchRows = computed(() => matches.value.map((m) => {
  const side = pickSide(m)
  const low = isLowOddsRecommend(m)
  const met = metricsOf(m)
  const st = statusBucket(m)
  return {
    m,
    id: String(m.id),
    st,
    stLabel: statusLabel(m),
    side,
    low,
    homeRk: playerRank('home', m),
    awayRk: playerRank('away', m),
    homeBest: playerBest('home', m),
    awayBest: playerBest('away', m),
    homeName: playerName('home', m),
    awayName: playerName('away', m),
    homeAge: playerAge('home', m),
    awayAge: playerAge('away', m),
    recLabel: recommendLabel(m),
    ageWarn: isAgeWarnRecommend(m),
    gap: met.ready ? met.gap : '—',
    strong: met.ready ? met.strongRank : '—',
    rankDiff: rankDiffText(m),
    timeBj: fmtBeijingTime(m),
    odds: oddsPair(m),
    poly: polyPair(m),
    polyUrl: polyUrlOf(m) || m.polymarket?.url || '',
    canSelect: canSelectMatch(m),
    tour: m.tour || (m.gender === 'F' ? 'WTA' : 'ATP'),
  }
}))

const filterSummary = computed(() => {
  const parts = []
  if (tourFilter.value !== 'all') parts.push(tourFilter.value)
  if (statusFilter.value === 'upcoming') parts.push('未开赛')
  else if (statusFilter.value === 'live') parts.push('比赛中')
  else if (statusFilter.value === 'finished') parts.push('完赛')
  if (pmFilter.value === 'yes') parts.push('有PM')
  if (pmFilter.value === 'no') parts.push('无PM')
  if (gapMin.value !== 'all') parts.push(`现差≥${gapMin.value}`)
  if (rankDiffMax.value !== 'all') parts.push(`史高排差≤${rankDiffMax.value}`)
  if (strongRankMax.value !== 'all') parts.push(`强现≤${strongRankMax.value}`)
  if (gapMode.value === 'tier') parts.push('分档现差')
  if (levelFilter.value !== 'all') parts.push(`级别${levelFilter.value}`)
  if (query.value.trim()) parts.push(`搜:${query.value.trim()}`)
  return parts.length ? parts.join(' · ') : '未限制'
})

const summary = computed(() => {
  const all = allMatches.value
  const shown = matches.value
  let live = 0
  let up = 0
  let done = 0
  let atp = 0
  let wta = 0
  for (const m of all) {
    const b = statusBucket(m)
    if (b === 'live') live += 1
    else if (b === 'finished') done += 1
    else up += 1
    const tour = String(m.tour || '').toUpperCase()
    const g = String(m.gender || '').toUpperCase()
    if (tour.includes('WTA') || g === 'F') wta += 1
    else atp += 1
  }
  return { total: all.length, shown: shown.length, live, up, done, atp, wta }
})

function polyUrlOf(m) {
  const fromMap = bundle.value?.polymarketByEvent?.[m?.id]
    || bundle.value?.polymarketByEvent?.[String(m?.id)]
  const url = String(fromMap?.url || m?.polymarket?.url || m?.polymarketUrl || '')
  return /polymarket\.com\/event\//i.test(url) ? url : ''
}

function pickSide(m) {
  const homeR = playerRank('home', m)
  const awayR = playerRank('away', m)
  if (homeR == null || awayR == null || homeR === awayR) return null
  return homeR < awayR ? 'home' : 'away'
}

function polyOf(m) {
  const id = m?.id
  const fromMap = bundle.value?.polymarketByEvent?.[id]
    || bundle.value?.polymarketByEvent?.[String(id)]
  return fromMap || m?.polymarket || null
}

/** 推荐侧 Polymarket 价格 0~1；无则 null */
function recommendPolyPrice(m) {
  const side = pickSide(m)
  if (!side) return null
  const poly = polyOf(m)
  if (!poly) return null
  let p = side === 'home' ? poly.home_price : poly.away_price
  const mlPrices = poly.moneyline?.prices
  if (p == null && Array.isArray(mlPrices)) {
    p = mlPrices[side === 'home' ? 0 : 1]
  }
  if (p == null && mlPrices && typeof mlPrices === 'object' && !Array.isArray(mlPrices)) {
    p = side === 'home' ? mlPrices.home : mlPrices.away
  }
  if (p == null && poly.prices && typeof poly.prices === 'object') {
    p = side === 'home' ? poly.prices.home : poly.prices.away
  }
  if (p == null) return null
  const n = Number(p)
  if (!Number.isFinite(n)) return null
  return n <= 1 ? n : n / 100
}

/** 推荐侧 PM 概率&lt;40% → 标「非」 */
function isLowOddsRecommend(m) {
  if (!pickSide(m)) return false
  const price = recommendPolyPrice(m)
  if (price == null) return false
  return price < 0.4
}

/** 低赔且年龄&gt;35 → 额外红色叹号 */
function isAgeWarnRecommend(m) {
  const side = pickSide(m)
  if (!side || !isLowOddsRecommend(m)) return false
  const age = playerAge(side, m)
  return age != null && age > 35
}

function recommendLabel(m) {
  return isLowOddsRecommend(m) ? '非' : '荐'
}

function canSelectMatch(m) {
  if (!m?.id || statusBucket(m) === 'finished') return false
  if (!polyUrlOf(m)) return false
  if (pickSide(m) == null) return false
  return true
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

const selectableMatches = computed(() => matches.value.filter(canSelectMatch))
const selectedCount = computed(() => selectedIds.value.size)

function summarizeMatch(m, rankings = {}) {
  if (!m) return null
  const mx = rankMetrics(m, rankings)
  const homeR = mx.homeR ?? playerRank('home', m)
  const awayR = mx.awayR ?? playerRank('away', m)
  const homeId = m.homePlayer?.id
  const awayId = m.awayPlayer?.id
  const homeMap = homeId != null ? (rankings[String(homeId)] || rankings[homeId]) : null
  const awayMap = awayId != null ? (rankings[String(awayId)] || rankings[awayId]) : null
  const homeBestN = Number(homeMap?.best ?? m.homePlayer?.bestRank ?? m.homePlayer?.best)
  const awayBestN = Number(awayMap?.best ?? m.awayPlayer?.bestRank ?? m.awayPlayer?.best)
  const homeBest = Number.isFinite(homeBestN) && homeBestN > 0 ? homeBestN : null
  const awayBest = Number.isFinite(awayBestN) && awayBestN > 0 ? awayBestN : null
  return {
    id: m.id,
    home: playerName('home', m),
    away: playerName('away', m),
    homeRank: homeR,
    awayRank: awayR,
    homeBest,
    awayBest,
    gap: mx.ready ? mx.gap : null,
    rankDiff: mx.ready ? mx.rankDiff : null,
    statusLabel: statusLabel(m),
    timeBj: fmtBeijingTime(m),
    startTime: m.startTime || '',
    tournament: m.tournamentName || m.tournament || '',
  }
}

const selectedMatchesForSettings = computed(() => {
  const rankings = bundle.value?.rankingsByPlayer || {}
  return [...selectedIds.value].map((id) => {
    const m = matches.value.find((x) => String(x.id) === String(id))
      || allMatches.value.find((x) => String(x.id) === String(id))
    return summarizeMatch(m, rankings) || {
      id,
      home: String(id),
      away: '',
      statusLabel: '',
      timeBj: '',
      startTime: '',
    }
  })
})

/** 设置页弹出选场：当前筛选列表 + 已选（避免被筛掉看不见） */
const matchOptionsForSettings = computed(() => {
  const rankings = bundle.value?.rankingsByPlayer || {}
  const map = new Map()
  for (const m of matches.value) {
    if (m?.id != null) map.set(String(m.id), summarizeMatch(m, rankings))
  }
  for (const id of selectedIds.value) {
    if (map.has(String(id))) continue
    const m = allMatches.value.find((x) => String(x.id) === String(id))
    const s = summarizeMatch(m, rankings)
    if (s) map.set(String(id), s)
  }
  return [...map.values()].filter(Boolean)
})

function removeSelectedMatch(id) {
  const key = String(id)
  const next = new Set(selectedIds.value)
  next.delete(key)
  selectedIds.value = next
  const skip = new Set(autoSelectSkipIds.value)
  skip.add(key)
  autoSelectSkipIds.value = skip
}

function matchesFocusGroup(g, focus) {
  if (!focus) return true
  const gKey = String(g?.strategyKey || '').trim()
  if (focus.strategyKey && gKey && gKey === String(focus.strategyKey).trim()) return true
  if (focus.id && String(g?.id || '') === String(focus.id)) return true
  if (!gKey && focus.name && String(g?.name || '').trim() === String(focus.name).trim()) return true
  return false
}

function applyAutoSelectFromCollect(payload = null, { resetSkip = false } = {}) {
  if (payload && typeof payload === 'object') {
    conditionSelectCfg.value = {
      auto: payload.auto !== false,
      prematchOn: !!payload.prematchOn,
      inplayOn: !!payload.inplayOn,
      prematchGroups: Array.isArray(payload.prematchGroups) ? payload.prematchGroups : [],
      inplayGroups: Array.isArray(payload.inplayGroups) ? payload.inplayGroups : [],
    }
  }
  const cfg = conditionSelectCfg.value || {}
  if (cfg.auto === false) return
  if (resetSkip) autoSelectSkipIds.value = new Set()

  // 至少有一个投注条件桶打开才按条件同步已选
  if (!cfg.prematchOn && !cfg.inplayOn) return

  const ctx = filterCtx.value
  const focus = focusStrategy.value
  const allowed = new Set()
  const collectBucket = (on, groups, pred) => {
    if (!on) return
    let gs = Array.isArray(groups) ? groups : []
    if (focus) gs = gs.filter((g) => matchesFocusGroup(g, focus))
    if (!gs.length) return
    const pool = allMatches.value.filter((m) => pred(m) && statusBucket(m) !== 'finished')
    const hit = filterMatchesByConditionGroups(pool, gs, ctx)
    for (const m of hit) {
      if (m?.id == null) continue
      allowed.add(String(m.id))
    }
  }
  collectBucket(cfg.prematchOn, cfg.prematchGroups, (m) => statusBucket(m) === 'upcoming')
  collectBucket(cfg.inplayOn, cfg.inplayGroups, (m) => statusBucket(m) === 'live')

  // 手动删除仅对「当前仍满足条件」的场次生效；已不满足的从 skip 清掉，方便条件放宽后重新选上
  const skip = autoSelectSkipIds.value
  const nextSkip = new Set()
  for (const id of skip) {
    if (allowed.has(id)) nextSkip.add(id)
  }
  autoSelectSkipIds.value = nextSkip

  const next = new Set()
  for (const id of allowed) {
    if (!nextSkip.has(id)) next.add(id)
  }
  selectedIds.value = next
}

function restoreSelectedMatches(ids) {
  const list = Array.isArray(ids) ? ids : []
  selectedIds.value = new Set(list.map((id) => String(id)).filter(Boolean))
  applyAutoSelectFromCollect(null, { resetSkip: true })
}

function toggleSelectedMatch(id) {
  const key = String(id)
  const next = new Set(selectedIds.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedIds.value = next
}

function onEditStrategyFromList(item) {
  focusStrategy.value = {
    strategyKey: String(item?.strategyKey || item?.key || '').trim(),
    name: String(item?.name || '').trim(),
    id: String(item?.id || '').trim(),
    bucket: item?.bucket === 'inplay' ? 'inplay' : 'prematch',
  }
  if (item?.bucket === 'inplay' || item?.bucket === 'prematch') {
    const opt = allStrategyOptions.value.find((o) => o.bucket === item.bucket && String(o.id) === String(item.id))
      || allStrategyOptions.value.find((o) => o.bucket === item.bucket)
    if (opt) bindStrategyOption(opt.key)
  }
  strategySettingsOpen.value = true
}

function openStrategySettings() {
  // 有勾选时进设置：优先当前激活策略；否则先打开策略列表选独立策略
  const g = activeStrategy.value
  if (g) {
    focusStrategy.value = {
      strategyKey: String(g.strategyKey || '').trim(),
      name: String(g.name || '').trim(),
      id: String(g.id || '').trim(),
      bucket: g.bucket,
    }
    strategySettingsOpen.value = true
    return
  }
  strategyListOpen.value = true
}
const pageAllSelected = computed(() => {
  const list = selectableMatches.value
  if (!list.length) return false
  return list.every((m) => selectedIds.value.has(String(m.id)))
})

function toggleSelectPage() {
  const list = selectableMatches.value
  if (!list.length) return
  const next = new Set(selectedIds.value)
  if (pageAllSelected.value) {
    for (const m of list) next.delete(String(m.id))
  } else {
    for (const m of list) next.add(String(m.id))
  }
  selectedIds.value = next
}

function bindStrategyOption(key) {
  activeGroupKey.value = String(key || '')
  const g = allStrategyOptions.value.find((x) => x.key === activeGroupKey.value)
  if (g && Number(g.amountUsd) >= 1) batchAmountUsd.value = String(g.amountUsd)
  const next = new Set()
  for (const m of matches.value) {
    if (selectedIds.value.has(String(m.id)) && canSelectMatch(m)) next.add(String(m.id))
  }
  selectedIds.value = next
}

async function loadBettingStrategies() {
  try {
    const cfg = await api.fetchTennisEngines()
    const buckets = cfg?.betting?.buckets || {}
    const condBuckets = cfg?.condition?.buckets || {}
    const condPm = condBuckets.prematch || {}
    const condIp = condBuckets.inplay || {}
    const flagSrc = (condPm.groups || [])[0] || (buckets?.prematch?.groups || [])[0]
      || (condIp.groups || [])[0] || (buckets?.inplay?.groups || [])[0] || {}
    conditionSelectCfg.value = {
      auto: flagSrc.autoSelectFromCollect !== false,
      prematchOn: !!condPm.enabled,
      inplayOn: !!condIp.enabled,
      prematchGroups: Array.isArray(condPm.groups) ? condPm.groups : [],
      inplayGroups: Array.isArray(condIp.groups) ? condIp.groups : [],
    }
    const norm = (key) => {
      const b = buckets[key] || {}
      const groups = Array.isArray(b.groups) ? b.groups : []
      return {
        enabled: !!b.enabled,
        simulate: !!b.simulate,
        groups: groups.map((g, i) => ({
          id: g.id || `g_${key}_${i}`,
          name: g.name || '',
          amountUsd: Number(g.amountUsd) >= 1 ? Number(g.amountUsd) : 1,
          stopEnabled: g.stopEnabled !== false,
          stopRules: Array.isArray(g.stopRules) ? g.stopRules : [],
        })),
      }
    }
    bettingBuckets.value = {
      prematch: norm('prematch'),
      inplay: norm('inplay'),
    }
    const opts = []
    for (const bucket of ['prematch', 'inplay']) {
      const b = bettingBuckets.value[bucket]
      for (const g of b.groups || []) {
        opts.push({ key: `${bucket}:${g.id}`, amountUsd: g.amountUsd })
      }
    }
    const first = opts[0]
    if (first) {
      activeGroupKey.value = first.key
      if (Number(first.amountUsd) >= 1) batchAmountUsd.value = String(first.amountUsd)
    } else {
      activeGroupKey.value = ''
    }
    applyAutoSelectFromCollect()
  } catch (e) {
    batchError.value = e?.response?.data?.error || e?.message || '加载投注策略失败'
  }
}

function buildBatchOrders() {
  return [...selectedIds.value].map((eventId) => {
    const m = matches.value.find((x) => String(x.id) === String(eventId))
    const side = pickSide(m)
    if (!m || !side || !canSelectMatch(m)) return null
    return {
      eventId,
      side,
      homeName: playerName('home', m),
      awayName: playerName('away', m),
    }
  }).filter(Boolean)
}

async function submitBatchTrade() {
  batchError.value = ''
  batchNotice.value = ''
  const orders = buildBatchOrders()
  if (!orders.length) {
    batchError.value = '请先勾选可投注场次（需 PM 外链 + 双方现排名）'
    return
  }
  const amount = Number(batchAmountUsd.value)
  if (!(amount >= 1)) {
    batchError.value = '金额至少 $1（可改策略组金额或手动填写）'
    return
  }
  const prematchOrders = []
  const inplayOrders = []
  for (const o of orders) {
    const m = matches.value.find((x) => String(x.id) === String(o.eventId))
      || allMatches.value.find((x) => String(x.id) === String(o.eventId))
    if (statusBucket(m) === 'live') inplayOrders.push(o)
    else prematchOrders.push(o)
  }
  batchSubmitting.value = true
  try {
    const allResults = []
    let messageParts = []
    if (prematchOrders.length) {
      const data = await api.placeTennisPrematchBatchTrade({ orders: prematchOrders, amountUsd: amount })
      allResults.push(...(Array.isArray(data?.results) ? data.results : []))
      if (data?.message) messageParts.push(data.message)
    }
    if (inplayOrders.length) {
      const data = await api.placeTennisInplayBatchTrade({ orders: inplayOrders, amountUsd: amount })
      allResults.push(...(Array.isArray(data?.results) ? data.results : []))
      if (data?.message) messageParts.push(data.message)
    }
    const ok = allResults.filter((r) => r.ok).length
    const fail = allResults.length - ok
    batchNotice.value = messageParts.join('；')
      || `已提交 ${orders.length} 场 · 成功 ${ok} · 失败 ${fail}`
    if (ok) {
      const next = new Set(selectedIds.value)
      const done = new Set(autoBetDoneIds.value)
      const sk = String(focusStrategy.value?.strategyKey || activeStrategy.value?.strategyKey || '').trim()
      const marked = []
      for (const r of allResults) {
        if (r.ok) {
          next.delete(String(r.eventId))
          done.add(autoBetDoneKey(sk, r.eventId))
          marked.push({
            eventId: r.eventId,
            shares: r.shares ?? r.takingAmount,
            amountUsd: r.amountUsd,
            price: r.price,
          })
        }
      }
      selectedIds.value = next
      autoBetDoneIds.value = done
      if (marked.length && sk) {
        // 分别标记赛前/赛中，写入引擎去重状态
        const preIds = new Set(prematchOrders.map((o) => String(o.eventId)))
        const inIds = new Set(inplayOrders.map((o) => String(o.eventId)))
        const preMarked = marked.filter((m) => preIds.has(String(m.eventId)))
        const inMarked = marked.filter((m) => inIds.has(String(m.eventId)))
        if (preMarked.length) {
          api.markTennisBettingPlaced({
            product: 'tennis-prematch',
            strategyKey: sk,
            orders: preMarked,
          }).catch(() => {})
        }
        if (inMarked.length) {
          api.markTennisBettingPlaced({
            product: 'tennis-inplay',
            strategyKey: sk,
            orders: inMarked,
          }).catch(() => {})
        }
      }
    }
    if (fail) {
      batchError.value = allResults.filter((r) => !r.ok).map((r) => r.error || '失败').slice(0, 3).join('；')
    }
  } catch (e) {
    batchError.value = e?.response?.data?.error || e?.message || '批量下单失败'
  } finally {
    batchSubmitting.value = false
  }
}

/** 策略「投注打开」后：按文本框金额给已选赛事自动下单（同桶状态） */
async function onAutoBetFromSettings(payload = {}) {
  const bucket = payload.bucket === 'inplay' ? 'inplay' : 'prematch'
  const amount = Number(payload.amountUsd)
  if (!(amount >= 1)) {
    batchError.value = '投注金额至少 $1'
    return
  }
  if (batchSubmitting.value) return

  const strategyKey = String(
    payload.strategyKey
    || focusStrategy.value?.strategyKey
    || activeStrategy.value?.strategyKey
    || '',
  ).trim()
  const wantLive = bucket === 'inplay'
  const orders = []
  for (const id of selectedIds.value) {
    const sid = String(id)
    if (autoBetDoneIds.value.has(autoBetDoneKey(strategyKey, sid))) continue
    const m = allMatches.value.find((x) => String(x.id) === sid)
      || matches.value.find((x) => String(x.id) === sid)
    if (!m || !canSelectMatch(m)) continue
    const live = statusBucket(m) === 'live'
    if (wantLive !== live) continue
    const side = pickSide(m)
    if (!side) continue
    orders.push({
      eventId: sid,
      side,
      homeName: playerName('home', m),
      awayName: playerName('away', m),
    })
  }
  if (!orders.length) {
    batchNotice.value = wantLive
      ? '投注已开：已选中暂无新的比赛中可下单场次'
      : '投注已开：已选中暂无新的未开赛可下单场次'
    return
  }

  batchSubmitting.value = true
  batchError.value = ''
  batchNotice.value = ''
  const simulate = !!payload.simulate
  try {
    const body = { orders, amountUsd: amount, simulate }
    const data = wantLive
      ? await api.placeTennisInplayBatchTrade(body)
      : await api.placeTennisPrematchBatchTrade(body)
    const results = Array.isArray(data?.results) ? data.results : []
    const ok = results.filter((r) => r.ok).length
    const fail = results.length - ok
    const done = new Set(autoBetDoneIds.value)
    const marked = []
    for (const r of results) {
      if (r.ok) {
        done.add(autoBetDoneKey(strategyKey, r.eventId))
        marked.push({
          eventId: r.eventId,
          shares: r.shares ?? r.takingAmount,
          amountUsd: r.amountUsd ?? amount,
          price: r.price,
        })
      }
    }
    autoBetDoneIds.value = done
    if (marked.length) {
      api.markTennisBettingPlaced({
        product: wantLive ? 'tennis-inplay' : 'tennis-prematch',
        strategyKey: strategyKey || '_',
        orders: marked,
      }).catch(() => {})
    }
    const mode = simulate || results.some((r) => r.simulated) ? '模拟' : '实盘'
    batchNotice.value = data?.message
      || `自动${mode}下单（${wantLive ? '比赛中' : '开赛前'} $${amount}）· 成功 ${ok} · 失败 ${fail}`
    if (fail) {
      batchError.value = results.filter((r) => !r.ok).map((r) => r.error || '失败').slice(0, 3).join('；')
    }
  } catch (e) {
    batchError.value = e?.response?.data?.error || e?.message || '自动下单失败'
  } finally {
    batchSubmitting.value = false
  }
}

async function load({ soft = false } = {}) {
  if (!soft) loading.value = true
  if (!soft) error.value = ''
  try {
    const data = await api.fetchTennisMonitorBundle()
    if (!data?.ok && data?.error) {
      error.value = String(data.error)
      bundle.value = data
      return
    }
    bundle.value = data
    if (!flattenEvents(data).length) {
      error.value = data?.message || 'Redis 暂无赛事，请先在采集引擎执行 Top100 采集'
    } else if (soft) {
      error.value = ''
    }
    applyAutoSelectFromCollect()
  } catch (e) {
    if (!soft) error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    if (!soft) loading.value = false
  }
}

function startPoll() {
  stopPoll()
  if (!autoRefresh.value) return
  pollTimer = setInterval(() => {
    if (!document.hidden) load({ soft: true })
  }, 30000)
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

const collecting = ref(false)
const collectRunning = ref(false)
const collectModalOpen = ref(false)
const collectSaving = ref(false)
const collectModalError = ref('')
const collectHorizonDays = ref(1)
const inplayFieldsSelected = ref(['score', 'odds'])

const COLLECT_HORIZON_OPTS = [
  { days: 1, label: '1 天（今天）' },
  { days: 2, label: '2 天（今天起）' },
  { days: 5, label: '5 天（今天起）' },
]
const INPLAY_FIELD_OPTS = [
  { key: 'score', label: '比分' },
  { key: 'odds', label: '赔率' },
]

const inplayFieldsOpen = ref(false)
const inplayFieldsLabel = computed(() => {
  const selected = new Set(inplayFieldsSelected.value || [])
  const labels = INPLAY_FIELD_OPTS.filter((o) => selected.has(o.key)).map((o) => o.label)
  return labels.length ? labels.join('、') : '请选择字段'
})

function isInplayFieldOn(key) {
  return (inplayFieldsSelected.value || []).includes(key)
}

function toggleInplayField(key) {
  const cur = new Set(inplayFieldsSelected.value || [])
  if (cur.has(key)) cur.delete(key)
  else cur.add(key)
  inplayFieldsSelected.value = INPLAY_FIELD_OPTS.map((o) => o.key).filter((k) => cur.has(k))
}

const logsOpen = ref(false)
const logsLoading = ref(false)
const logsError = ref('')
const logLines = ref([])
const logFile = ref('')

async function refreshCollectStatus() {
  try {
    const st = await api.fetchTennisMonitorStatus()
    collectRunning.value = !!(st?.top100_collect?.running || st?.running)
  } catch {
    /* ignore */
  }
}

async function loadInplayTickSettings() {
  try {
    const eng = await api.fetchTennisEngines()
    const c = eng?.collect || {}
    const f = c.inplay_tick_fields || {}
    const picked = []
    if (f.score !== false) picked.push('score')
    if (f.odds !== false) picked.push('odds')
    inplayFieldsSelected.value = picked.length ? picked : ['score', 'odds']
  } catch {
    /* keep defaults */
  }
}

async function openCollectModal() {
  collectModalError.value = ''
  inplayFieldsOpen.value = false
  collectModalOpen.value = true
  try {
    const sch = await api.fetchTennisMonitorSchedule()
    const days = Number(sch?.collect_horizon_days)
    collectHorizonDays.value = COLLECT_HORIZON_OPTS.some((o) => o.days === days) ? days : 1
  } catch {
    /* keep defaults */
  }
  await loadInplayTickSettings()
  await refreshCollectStatus()
}

async function saveCollectSchedule() {
  const data = await api.updateTennisMonitorSchedule({
    collect_horizon_days: Number(collectHorizonDays.value),
  })
  const days = Number(data?.collect_horizon_days)
  if (COLLECT_HORIZON_OPTS.some((o) => o.days === days)) collectHorizonDays.value = days

  const eng = await api.updateTennisEngines({
    collect: {
      inplay_tick_enabled: true,
      inplay_tick_fields: {
        score: (inplayFieldsSelected.value || []).includes('score'),
        odds: (inplayFieldsSelected.value || []).includes('odds'),
      },
    },
  })
  const f = eng?.collect?.inplay_tick_fields || {}
  const picked = []
  if (f.score !== false) picked.push('score')
  if (f.odds !== false) picked.push('odds')
  inplayFieldsSelected.value = picked.length ? picked : []
}

async function saveCollectScheduleOnly() {
  if (collectSaving.value || collecting.value) return
  collectSaving.value = true
  collectModalError.value = ''
  try {
    await saveCollectSchedule()
    collectModalOpen.value = false
  } catch (e) {
    collectModalError.value = e?.response?.data?.error || e?.message || '保存采集时间失败'
  } finally {
    collectSaving.value = false
  }
}

async function triggerTop100Collect() {
  if (collecting.value || collectRunning.value) return
  collecting.value = true
  collectModalError.value = ''
  error.value = ''
  try {
    await saveCollectSchedule()
    await api.triggerTennisMonitorCollect({ fromTxt: false })
    collectModalOpen.value = false
    await refreshCollectStatus()
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      await refreshCollectStatus()
      if (!collectRunning.value) break
    }
    await load()
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || 'Top100 采集失败'
    collectModalError.value = msg
    error.value = msg
  } finally {
    collecting.value = false
    await refreshCollectStatus()
  }
}

async function openCollectLogs() {
  logsOpen.value = true
  logsLoading.value = true
  logsError.value = ''
  try {
    const data = await api.fetchTennisMonitorLogs(200)
    logFile.value = data?.file || data?.log_file || ''
    const raw = data?.lines || data?.text || data?.content || ''
    if (Array.isArray(raw)) logLines.value = raw.map(String)
    else logLines.value = String(raw || '').split(/\r?\n/).filter((l, i, a) => l || i < a.length - 1)
  } catch (e) {
    logsError.value = e?.response?.data?.error || e?.message || '加载日志失败'
    logLines.value = []
  } finally {
    logsLoading.value = false
  }
}

onMounted(() => {
  // 先出赛事列表；策略/钱包（含链上余额）后台拉，不挡首屏
  load().finally(() => startPoll())
  loadBettingStrategies()
  loadWalletHeader()
  refreshCollectStatus()
})

onUnmounted(stopPoll)
</script>

<template>
  <div class="t100w" :class="{ standalone }">
    <header class="bar">
      <div class="bar-left">
        <div class="brand">网球赛事 · 前100名赛事信息 <span class="build-tag" title="前端构建标记">v0916c</span></div>
      </div>
      <div class="bar-collect">
        <button
          type="button"
          class="btn primary"
          :disabled="collecting || collectRunning || loading"
          @click="openCollectModal"
        >{{ collectRunning || collecting ? '采集中…' : 'Top100采集' }}</button>
        <button type="button" class="btn ghost" @click="openCollectLogs">采集日志</button>
      </div>
      <div class="bar-stats">
        <span>池内 <b class="n n-total">{{ summary.total }}</b></span>
        <span>筛选后 <b class="n n-shown">{{ summary.shown }}</b></span>
        <span>ATP <b class="n n-atp">{{ summary.atp }}</b></span>
        <span>WTA <b class="n n-wta">{{ summary.wta }}</b></span>
        <span class="live">比赛中 <b class="n n-live">{{ summary.live }}</b></span>
      </div>
      <div class="bar-actions">
        <button
          v-if="selectedCount"
          type="button"
          class="btn ghost"
          title="策略设置"
          @click="openStrategySettings"
        >设置 · {{ selectedCount }}</button>
        <button
          v-if="selectedCount"
          type="button"
          class="btn ghost"
          @click="clearSelection"
        >清选</button>
        <div v-if="batchNotice" class="batch-ok">{{ batchNotice }}</div>
        <div v-if="batchError" class="batch-err">{{ batchError }}</div>
        <input v-model="query" class="search" type="search" placeholder="搜球员 / 赛事" />
        <label class="chk">
          <input v-model="autoRefresh" type="checkbox" @change="startPoll" />
          自动刷新
        </label>
        <button type="button" class="btn ghost" @click="columnsOpen = !columnsOpen">
          {{ columnsOpen ? '收起列' : '列显示' }}
        </button>
        <button type="button" class="btn ghost" @click="filtersOpen = !filtersOpen">
          {{ filtersOpen ? '收起条件' : '条件过滤' }}
        </button>
        <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>
        <button
          type="button"
          class="btn strategy-list-btn"
          title="查看 / 新建 / 命名策略"
          @click="strategyListOpen = true"
        >策略列表</button>
        <button
          type="button"
          class="btn ghost"
          title="查看下单后的订单"
          @click="openOrders"
        >订单列表</button>
        <div v-if="canShowWallet" class="wallet-slot">
          <div
            v-if="walletConfigured"
            class="wallet-bal"
            title="账户余额"
          >
            <span class="wallet-bal-l">余额</span>
            <span class="wallet-bal-n">${{ fmtWalletUsdc(walletUsdcBalance) }}</span>
          </div>
          <button
            type="button"
            class="btn wallet-btn"
            :title="walletConfigured ? '账户已配置' : '账户设置'"
            @click="showWalletSettings = true"
          >
            <span>{{ walletConfigured ? '已配' : '钱包' }}</span>
            <span class="wallet-dot" :class="{ on: walletConfigured }"></span>
          </button>
        </div>
      </div>
    </header>

    <section v-show="columnsOpen" class="filters cols-panel">
      <div class="filters-head">
        <span class="filters-title">列显示</span>
        <span class="filters-sum">勾选要显示的列（会记住）</span>
        <button type="button" class="link-btn" @click="showAllCols">全部显示</button>
      </div>
      <div class="col-grid">
        <label v-for="c in COLUMN_DEFS" :key="c.key" class="col-item">
          <input type="checkbox" :checked="colOn(c.key)" @change="toggleCol(c.key)" />
          <span>{{ c.label }}</span>
        </label>
      </div>
    </section>

    <section v-show="filtersOpen" class="filters">
      <div class="filters-head">
        <span class="filters-title">条件过滤</span>
        <span class="filters-sum">{{ filterSummary }}</span>
        <button type="button" class="link-btn" @click="resetFilters">清空</button>
      </div>

      <div class="filter-row">
        <span class="label">状态</span>
        <button type="button" class="chip" :class="{ on: statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
        <button type="button" class="chip" :class="{ on: statusFilter === 'upcoming' }" @click="statusFilter = 'upcoming'">未开赛</button>
        <button type="button" class="chip" :class="{ on: statusFilter === 'live' }" @click="statusFilter = 'live'">比赛中</button>
        <button type="button" class="chip" :class="{ on: statusFilter === 'finished' }" @click="statusFilter = 'finished'">完赛</button>
      </div>

      <div class="filter-row">
        <span class="label">巡回</span>
        <button type="button" class="chip" :class="{ on: tourFilter === 'all' }" @click="tourFilter = 'all'">全部</button>
        <button type="button" class="chip" :class="{ on: tourFilter === 'ATP' }" @click="tourFilter = 'ATP'">ATP</button>
        <button type="button" class="chip" :class="{ on: tourFilter === 'WTA' }" @click="tourFilter = 'WTA'">WTA</button>
      </div>

      <div class="filter-row">
        <span class="label">级别</span>
        <button type="button" class="chip" :class="{ on: levelFilter === 'all' }" @click="levelFilter = 'all'">全部</button>
        <button type="button" class="chip" :class="{ on: levelFilter === 'gs' }" @click="levelFilter = 'gs'">大满贯</button>
        <button type="button" class="chip" :class="{ on: levelFilter === '1000' }" @click="levelFilter = '1000'">1000</button>
        <button type="button" class="chip" :class="{ on: levelFilter === '500' }" @click="levelFilter = '500'">500</button>
        <button type="button" class="chip" :class="{ on: levelFilter === '250' }" @click="levelFilter = '250'">250</button>
      </div>

      <div class="filter-row">
        <span class="label">PM</span>
        <button type="button" class="chip" :class="{ on: pmFilter === 'all' }" @click="pmFilter = 'all'">全部</button>
        <button type="button" class="chip" :class="{ on: pmFilter === 'yes' }" @click="pmFilter = 'yes'">有外链</button>
        <button type="button" class="chip" :class="{ on: pmFilter === 'no' }" @click="pmFilter = 'no'">无外链</button>
      </div>

      <div class="filter-row">
        <span class="label">现差</span>
        <button type="button" class="chip" :class="{ on: gapMin === 'all' }" @click="gapMin = 'all'">不限</button>
        <button type="button" class="chip" :class="{ on: gapMin === '50' }" @click="gapMin = '50'">≥50</button>
        <button type="button" class="chip" :class="{ on: gapMin === '70' }" @click="gapMin = '70'">≥70</button>
        <button type="button" class="chip" :class="{ on: gapMin === '90' }" @click="gapMin = '90'">≥90</button>
        <button type="button" class="chip" :class="{ on: gapMin === '150' }" @click="gapMin = '150'">≥150</button>
      </div>

      <div class="filter-row">
        <span class="label">历史最高排位差</span>
        <button type="button" class="chip" :class="{ on: rankDiffMax === 'all' }" @click="rankDiffMax = 'all'">不限</button>
        <button type="button" class="chip" :class="{ on: rankDiffMax === '0' }" @click="rankDiffMax = '0'">≤0</button>
        <button type="button" class="chip" :class="{ on: rankDiffMax === '-10' }" @click="rankDiffMax = '-10'">≤-10</button>
        <button type="button" class="chip" :class="{ on: rankDiffMax === '10' }" @click="rankDiffMax = '10'">≤10</button>
      </div>

      <div class="filter-row">
        <span class="label">强现</span>
        <button type="button" class="chip" :class="{ on: strongRankMax === 'all' }" @click="strongRankMax = 'all'">不限</button>
        <button type="button" class="chip" :class="{ on: strongRankMax === '10' }" @click="strongRankMax = '10'">≤10</button>
        <button type="button" class="chip" :class="{ on: strongRankMax === '20' }" @click="strongRankMax = '20'">≤20</button>
        <button type="button" class="chip" :class="{ on: strongRankMax === '50' }" @click="strongRankMax = '50'">≤50</button>
        <button type="button" class="chip" :class="{ on: strongRankMax === '100' }" @click="strongRankMax = '100'">≤100</button>
      </div>

      <div class="filter-row">
        <span class="label">分档</span>
        <button type="button" class="chip" :class="{ on: gapMode === 'all' }" @click="gapMode = 'all'">关闭</button>
        <button type="button" class="chip" :class="{ on: gapMode === 'tier' }" @click="gapMode = 'tier'">分档现差</button>
        <span class="hint">Top10&gt;20 · Top20&gt;30 · Top50&gt;50 · Top100&gt;150</span>
      </div>
    </section>

    <div v-if="error" class="banner">{{ error }}</div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="c-check">
              <input
                type="checkbox"
                :checked="pageAllSelected"
                :disabled="!selectableMatches.length"
                title="全选当前列表可选场次"
                @change="toggleSelectPage"
              />
            </th>
            <th v-if="colOn('timeBj')" class="c-time-bj">北京时间</th>
            <th v-if="colOn('status')" class="c-st">状态</th>
            <th v-if="colOn('tour')" class="c-tour">巡回</th>
            <th v-if="colOn('level')" class="c-level">级别</th>
            <th v-if="colOn('tourney')" class="c-tourney">赛事</th>
            <th v-if="colOn('round')" class="c-round">轮次</th>
            <th v-if="colOn('home')" class="c-home">
              <div class="player-col-h">主</div>
              <div class="player-col-sub">※ 现排名 运动员名字（岁数）</div>
            </th>
            <th v-if="colOn('away')" class="c-away">
              <div class="player-col-h">客</div>
              <div class="player-col-sub">※ 现排名(历史最高) 名字（岁数）</div>
            </th>
            <th v-if="colOn('side')" class="c-side">建议</th>
            <th v-if="colOn('gap')" class="c-gap">现差</th>
            <th v-if="colOn('rankDiff')" class="c-gap c-rankdiff">
              <div class="rankdiff-h">历史最高排位差</div>
              <div class="rankdiff-sub">※ 强者现排名 − 弱者历史最高</div>
            </th>
            <th v-if="colOn('strong')" class="c-gap">强现</th>
            <th v-if="colOn('score')" class="c-score">比分</th>
            <th v-if="colOn('odds')" class="c-odds">赔率</th>
            <th v-if="colOn('poly')" class="c-poly">Polymarket</th>
            <th v-if="colOn('link')" class="c-link">链接</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in matchRows"
            :key="row.id"
            :class="['row', row.st, { selected: isSelected(row.m), disabled: !row.canSelect }]"
          >
            <td class="c-check">
              <input
                type="checkbox"
                :checked="isSelected(row.m)"
                :disabled="!row.canSelect"
                @change="toggleSelect(row.m)"
              />
            </td>
            <td v-if="colOn('timeBj')" class="c-time-bj">{{ row.timeBj }}</td>
            <td v-if="colOn('status')" class="c-st">
              <span class="pill" :class="row.st">{{ row.stLabel }}</span>
            </td>
            <td v-if="colOn('tour')" class="c-tour">{{ row.tour }}</td>
            <td v-if="colOn('level')" class="c-level">{{ row.m.level || '—' }}</td>
            <td v-if="colOn('tourney')" class="c-tourney" :title="row.m.tournamentShort || row.m.tournamentName">{{ row.m.tournamentName || '—' }}</td>
            <td v-if="colOn('round')" class="c-round">{{ row.m.roundLabel || row.m.round || '—' }}</td>
            <td v-if="colOn('home')" class="c-home" :class="{ recommend: row.side === 'home' && !row.low, norec: row.side === 'home' && row.low }">
              <span class="player-rk">
                {{ row.homeRk ?? '—' }}<span
                  v-if="row.homeBest != null"
                  class="player-best"
                  :class="{ up: row.homeRk != null && row.homeBest < row.homeRk }"
                >({{ row.homeBest }})</span>
              </span>
              <span class="player-name">{{ row.homeName }}</span>
              <span v-if="row.homeAge != null" class="player-age">({{ row.homeAge }}岁)</span>
              <template v-if="row.side === 'home'">
                <span class="rec-tag" :class="{ low: row.low }">{{ row.recLabel }}</span>
                <span v-if="row.ageWarn" class="rec-warn" title="推荐侧年龄>35 且 PM&lt;40%">!</span>
              </template>
            </td>
            <td v-if="colOn('away')" class="c-away" :class="{ recommend: row.side === 'away' && !row.low, norec: row.side === 'away' && row.low }">
              <span class="player-rk">
                {{ row.awayRk ?? '—' }}<span
                  v-if="row.awayBest != null"
                  class="player-best"
                  :class="{ up: row.awayRk != null && row.awayBest < row.awayRk }"
                >({{ row.awayBest }})</span>
              </span>
              <span class="player-name">{{ row.awayName }}</span>
              <span v-if="row.awayAge != null" class="player-age">({{ row.awayAge }}岁)</span>
              <template v-if="row.side === 'away'">
                <span class="rec-tag" :class="{ low: row.low }">{{ row.recLabel }}</span>
                <span v-if="row.ageWarn" class="rec-warn" title="推荐侧年龄>35 且 PM&lt;40%">!</span>
              </template>
            </td>
            <td v-if="colOn('side')" class="c-side">{{ row.side === 'home' ? '主' : (row.side === 'away' ? '客' : '—') }}</td>
            <td v-if="colOn('gap')" class="c-gap">{{ row.gap }}</td>
            <td v-if="colOn('rankDiff')" class="c-gap c-rankdiff" title="强者现排名 − 弱者历史最高">
              {{ row.rankDiff }}
            </td>
            <td v-if="colOn('strong')" class="c-gap">{{ row.strong }}</td>
            <td v-if="colOn('score')" class="c-score">{{ row.m.scoreText || '—' }}</td>
            <td v-if="colOn('odds')" class="c-odds">{{ row.odds }}</td>
            <td v-if="colOn('poly')" class="c-poly">
              <a
                v-if="row.polyUrl"
                :href="row.polyUrl"
                target="_blank"
                rel="noopener noreferrer"
              >{{ row.poly }}</a>
              <span v-else>{{ row.poly }}</span>
            </td>
            <td v-if="colOn('link')" class="c-link">
              <a
                v-if="row.m.url"
                :href="row.m.url"
                target="_blank"
                rel="noopener noreferrer"
              >Sofa</a>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!matchRows.length">
            <td :colspan="visibleColCount" class="empty">
              {{ loading ? '加载中…' : '当前筛选下无赛事' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <TennisStrategySettings
      v-model:open="strategySettingsOpen"
      :focus-strategy="focusStrategy"
      :selected-matches="selectedMatchesForSettings"
      :match-options="matchOptionsForSettings"
      @saved="loadBettingStrategies"
      @select-by-conditions="(p) => applyAutoSelectFromCollect(p, { resetSkip: true })"
      @auto-bet="onAutoBetFromSettings"
      @remove-match="removeSelectedMatch"
      @toggle-match="toggleSelectedMatch"
      @restore-matches="restoreSelectedMatches"
    />
    <TennisStrategyList
      v-model:open="strategyListOpen"
      @changed="loadBettingStrategies"
      @edit="onEditStrategyFromList"
    />
    <WalletSettings
      :open="showWalletSettings"
      @close="showWalletSettings = false"
      @updated="onWalletUpdated"
    />

    <div v-if="collectModalOpen" class="clog-mask" @click.self="collectModalOpen = false; inplayFieldsOpen = false">
      <div class="ccollect-panel" role="dialog" aria-modal="true" aria-label="Top100 采集">
        <header class="clog-head">
          <div>
            <div class="clog-title">Top100 采集</div>
            <div class="clog-sub">设置采集范围与未开赛 / 比赛中间隔后开始采集</div>
          </div>
          <button type="button" class="btn ghost" @click="collectModalOpen = false; inplayFieldsOpen = false">关闭</button>
        </header>
        <div class="ccollect-body" @click="inplayFieldsOpen = false">
          <label class="ccollect-field">
            <span class="ccollect-k">时间范围</span>
            <select v-model.number="collectHorizonDays" :disabled="collectSaving || collecting">
              <option v-for="o in COLLECT_HORIZON_OPTS" :key="o.days" :value="o.days">{{ o.label }}</option>
            </select>
            <span class="ccollect-hint">从今天起拉多少天的赛事</span>
          </label>
          <div class="ccollect-field">
            <span class="ccollect-k">比赛中采集字段</span>
            <div class="ccollect-ms" :class="{ open: inplayFieldsOpen, disabled: collectSaving || collecting }" @click.stop>
              <button
                type="button"
                class="ccollect-ms-btn"
                :disabled="collectSaving || collecting"
                @click="inplayFieldsOpen = !inplayFieldsOpen"
              >
                <span>{{ inplayFieldsLabel }}</span>
                <span class="ccollect-ms-caret">▾</span>
              </button>
              <div v-if="inplayFieldsOpen" class="ccollect-ms-menu">
                <label
                  v-for="o in INPLAY_FIELD_OPTS"
                  :key="o.key"
                  class="ccollect-ms-item"
                >
                  <input
                    type="checkbox"
                    :checked="isInplayFieldOn(o.key)"
                    :disabled="collectSaving || collecting"
                    @change="toggleInplayField(o.key)"
                  />
                  {{ o.label }}
                </label>
              </div>
            </div>
            <span class="ccollect-hint">下拉多选；赔率=Polymarket</span>
          </div>
          <p v-if="collectModalError" class="clog-err">{{ collectModalError }}</p>
        </div>
        <footer class="ccollect-foot">
          <button type="button" class="btn ghost" :disabled="collectSaving || collecting" @click="saveCollectScheduleOnly">
            {{ collectSaving ? '保存中…' : '仅保存' }}
          </button>
          <button
            type="button"
            class="btn primary"
            :disabled="collectSaving || collecting || collectRunning"
            @click="triggerTop100Collect"
          >{{ collecting || collectRunning ? '采集中…' : '保存并采集' }}</button>
        </footer>
      </div>
    </div>

    <div v-if="logsOpen" class="clog-mask" @click.self="logsOpen = false">
      <div class="clog-panel" role="dialog" aria-modal="true" aria-label="采集日志">
        <header class="clog-head">
          <div>
            <div class="clog-title">采集日志</div>
            <div class="clog-sub">{{ logFile || '最近 Top100 / 采集输出' }}</div>
          </div>
          <div class="clog-actions">
            <button type="button" class="btn ghost" :disabled="logsLoading" @click="openCollectLogs">刷新</button>
            <button type="button" class="btn ghost" @click="logsOpen = false">关闭</button>
          </div>
        </header>
        <p v-if="logsError" class="clog-err">{{ logsError }}</p>
        <p v-else-if="logsLoading" class="clog-msg">加载中…</p>
        <pre v-else class="clog-pre">{{ logLines.length ? logLines.join('\n') : '（暂无日志）' }}</pre>
      </div>
    </div>

    <div v-if="ordersOpen" class="clog-mask" @click.self="ordersOpen = false">
      <div class="orders-panel" role="dialog" aria-modal="true" aria-label="订单列表">
        <header class="orders-head">
          <div class="orders-head-main">
            <div class="orders-title-row">
              <span class="orders-badge">ORDERS</span>
              <h3 class="orders-title">订单列表</h3>
            </div>
            <p class="orders-sub">
              共 <b>{{ ordersTotal }}</b> 条买卖记录
              <template v-if="ordersAccount"> · {{ ordersAccount }}</template>
            </p>
          </div>
          <div class="orders-head-actions">
            <button
              type="button"
              class="obtn danger"
              :disabled="ordersLoading || ordersClearing || !orders.length"
              @click="clearOrders"
            >{{ ordersClearing ? '清空中…' : '清空' }}</button>
            <button type="button" class="obtn" :disabled="ordersLoading || ordersClearing" @click="loadOrders">
              {{ ordersLoading ? '刷新中…' : '刷新' }}
            </button>
            <button type="button" class="obtn" @click="ordersOpen = false">关闭</button>
          </div>
        </header>

        <p v-if="ordersError" class="orders-err">{{ ordersError }}</p>

        <div v-if="ordersLoading && !orders.length" class="orders-empty">加载中…</div>
        <div v-else-if="!orders.length" class="orders-empty">
          <div class="orders-empty-ico">∅</div>
          <div>暂无订单</div>
          <div class="orders-empty-hint">策略或手动下单成功后会出现在这里</div>
        </div>
        <div v-else class="orders-list">
          <article
            v-for="row in orders"
            :key="row.id"
            class="order-card"
            :class="{
              fail: row.ok === false,
              sell: row.action === 'sell',
              buy: row.action !== 'sell' && row.ok !== false,
            }"
          >
            <div class="order-card-top">
              <div class="order-chips">
                <span class="ochip time">{{ fmtOrderAt(row.createdAt) }}</span>
                <span class="ochip">{{ orderProductLabel(row.product) }}</span>
                <span class="ochip" :class="row.action === 'sell' ? 'sell' : 'buy'">
                  {{ row.action === 'sell' ? '卖出' : '买入' }}
                </span>
                <span v-if="orderSideLabel(row.side)" class="ochip side">{{ orderSideLabel(row.side) }}</span>
                <span v-if="row.ok === false" class="ochip fail">失败</span>
                <span v-else-if="orderAlreadySold(row)" class="ochip sold">已平仓</span>
              </div>
              <div class="order-card-acts">
                <button
                  v-if="canSellOrder(row)"
                  type="button"
                  class="order-sell"
                  title="卖出平仓"
                  :disabled="ordersBusyId === row.id || ordersClearing"
                  @click="sellOrder(row)"
                >{{ ordersBusyId === row.id ? '…' : '卖出' }}</button>
                <button
                  type="button"
                  class="order-del"
                  title="删除"
                  :disabled="ordersBusyId === row.id || ordersClearing"
                  @click="removeOrder(row)"
                >{{ ordersBusyId === row.id ? '…' : '删除' }}</button>
              </div>
            </div>
            <div class="order-match">{{ row.label || '—' }}</div>
            <div class="order-foot">
              <span class="order-amt">{{ orderAmountTxt(row) }}</span>
              <span v-if="row.error" class="order-err">{{ row.error }}</span>
              <span v-else-if="row.orderId" class="order-oid" :title="row.orderId">{{ shortOrderId(row.orderId) }}</span>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.t100w {
  --ink: #0f172a;
  --muted: #64748b;
  --line: #e2e8f0;
  --bg: #f1f5f9;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 18px;
  padding: 12px 16px;
  background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%);
  color: #e2e8f0;
  position: sticky;
  top: 0;
  z-index: 20;
}
.brand {
  font-size: 17px;
  font-weight: 700;
}
.build-tag {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  vertical-align: middle;
}
.bar-collect {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.bar-collect .btn.primary {
  background: #0ea5e9;
  border-color: #0284c7;
  color: #fff;
  font-weight: 700;
}
.meta {
  display: flex;
  gap: 6px;
  font-size: 12px;
  color: #94a3b8;
}
.bar-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 14px 18px;
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #94a3b8;
}
.bar-stats .n {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin-left: 4px;
}
.bar-stats .n-total { color: #e2e8f0; }
.bar-stats .n-shown { color: #38bdf8; }
.bar-stats .n-atp { color: #34d399; }
.bar-stats .n-wta { color: #c084fc; }
.bar-stats .n-live { color: #f87171; }
.bar-stats .live { color: #fca5a5; font-weight: 700; }
.bar-actions {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
}
.wallet-slot {
  display: inline-flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  margin-left: 4px;
  padding-left: 10px;
  border-left: 1px solid #475569;
}
.wallet-bal {
  order: 1;
  display: inline-flex;
  flex-direction: row;
  align-items: baseline;
  gap: 6px;
  line-height: 1.2;
  padding: 4px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid #475569;
  white-space: nowrap;
}
.wallet-bal-l {
  font-size: 11px;
  color: #94a3b8;
  font-weight: 600;
}
.wallet-bal-n {
  font-size: 14px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: #6ee7b7;
}
.wallet-btn {
  order: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.wallet-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #64748b;
}
.wallet-dot.on {
  background: #34d399;
}
.strategy-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: min(560px, 92vw);
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid #334155;
}
.strategy-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.strategy-sel {
  height: 30px;
  max-width: 200px;
  border-radius: 8px;
  border: 1px solid #475569;
  background: #0f172a;
  color: #f8fafc;
  padding: 0 8px;
  font-size: 12px;
}
.amt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid #475569;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
}
.amt input {
  width: 56px;
  border: 0;
  outline: none;
  background: transparent;
  color: #fff;
  font-weight: 700;
}
.chk.all { color: #e2e8f0; }
.sel-count {
  min-width: 18px;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #93c5fd;
}
.strategy-sum {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.35;
}
.batch-ok { font-size: 11px; color: #86efac; }
.batch-err { font-size: 11px; color: #fca5a5; }
.chip.sm {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #cbd5e1;
  font-size: 12px;
  cursor: pointer;
}
.chip.sm.on {
  background: #f8fafc;
  border-color: #f8fafc;
  color: #0f172a;
  font-weight: 700;
}
.c-check {
  width: 36px;
  text-align: center;
}
.c-side {
  width: 40px;
  font-weight: 700;
  color: #0369a1;
}
tbody tr.selected {
  background: #eff6ff;
}
tbody tr.disabled td.c-check {
  opacity: 0.35;
}
.search {
  width: 160px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid #475569;
  background: #0f172a;
  color: #f8fafc;
  padding: 0 10px;
  font-size: 12px;
  outline: none;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #cbd5e1;
  cursor: pointer;
  user-select: none;
}
.btn {
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid #0ea5e9;
  background: #0284c7;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn.ghost {
  background: #334155;
  border-color: #64748b;
}
.btn.strategy-list-btn {
  background: #0f172a;
  border-color: #38bdf8;
  color: #e0f2fe;
  font-weight: 700;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.filters {
  margin: 10px 12px 0;
  padding: 10px 12px 12px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.filters-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.filters-title {
  font-size: 13px;
  font-weight: 700;
}
.filters-sum {
  font-size: 12px;
  color: var(--muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-btn {
  border: 0;
  background: transparent;
  color: #0284c7;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.filter-row .label {
  width: 36px;
  font-size: 12px;
  font-weight: 700;
  color: #475569;
  flex-shrink: 0;
}
.chip {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  color: #334155;
  font-size: 12px;
  cursor: pointer;
}
.chip.on {
  background: #0f172a;
  border-color: #0f172a;
  color: #fff;
  font-weight: 700;
}
.hint {
  font-size: 11px;
  color: #94a3b8;
  margin-left: 4px;
}

.banner {
  margin: 10px 16px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fff7ed;
  color: #c2410c;
  font-size: 13px;
}
.table-wrap {
  flex: 1;
  overflow: auto;
  margin: 12px 12px 16px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  max-height: calc(100vh - 220px);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  min-width: 1400px;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: #f8fafc;
  text-align: left;
  padding: 9px 10px;
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
tbody td {
  padding: 8px 10px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
  white-space: nowrap;
}
tbody tr:hover { background: #f8fafc; }
tbody tr.row {
  content-visibility: auto;
  contain-intrinsic-size: auto 42px;
}
tbody tr.live { background: #fef2f2; }
tbody tr.finished { opacity: 0.72; }
.col-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}
.col-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #334155;
  cursor: pointer;
  user-select: none;
}
.c-time-bj {
  width: 110px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: #0f766e;
}
.c-st { width: 64px; }
.c-tour { width: 48px; font-weight: 700; }
.c-level { width: 72px; color: #475569; }
.c-tourney { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.c-round { width: 88px; color: #64748b; }
.c-home, .c-away {
  font-weight: 650;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
th.c-home, th.c-away {
  white-space: normal;
  line-height: 1.25;
  vertical-align: bottom;
  overflow: visible;
  text-overflow: unset;
}
.player-col-h {
  font-size: 12px;
  font-weight: 800;
  color: #334155;
}
.player-col-sub {
  margin-top: 2px;
  font-size: 10px;
  font-weight: 500;
  color: #94a3b8;
  line-height: 1.3;
  white-space: normal;
}
.player-rk {
  display: inline-block;
  min-width: 1.6em;
  margin-right: 4px;
  color: #dc2626;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.player-best {
  color: inherit;
  font-weight: 700;
}
.player-best.up {
  color: #16a34a;
}
.c-home.recommend .player-name,
.c-away.recommend .player-name {
  color: #c2410c;
  font-weight: 800;
}
.c-home.norec .player-name,
.c-away.norec .player-name {
  color: #15803d;
  font-weight: 800;
}
.player-age {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.c-rankdiff {
  min-width: 148px;
  font-weight: 700;
  color: #5b21b6;
  font-variant-numeric: tabular-nums;
  white-space: normal;
  line-height: 1.25;
  vertical-align: bottom;
}
.rankdiff-h {
  font-size: 12px;
  font-weight: 800;
  color: #5b21b6;
  white-space: nowrap;
}
.rankdiff-sub {
  margin-top: 2px;
  font-size: 10px;
  font-weight: 500;
  color: #94a3b8;
  line-height: 1.3;
  white-space: normal;
}
.rec-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 800;
  line-height: 1.35;
  color: #fff;
  background: #ea580c;
  vertical-align: 1px;
}
.rec-tag.low {
  background: #16a34a;
}
.rec-tag.bad {
  background: #dc2626;
}
.rec-warn {
  display: inline-block;
  margin-left: 3px;
  color: #dc2626;
  font-size: 14px;
  font-weight: 900;
  line-height: 1;
  vertical-align: 1px;
}
.c-rk, .c-gap { width: 52px; font-variant-numeric: tabular-nums; color: #64748b; }
.c-score { width: 72px; font-variant-numeric: tabular-nums; }
.c-odds, .c-poly { font-variant-numeric: tabular-nums; color: #334155; }
.c-poly a, .c-link a {
  color: #0284c7;
  text-decoration: none;
  font-weight: 600;
}
.c-poly a:hover, .c-link a:hover { text-decoration: underline; }
.pill {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.03em;
  background: #e2e8f0;
  color: #475569;
}
.pill.live { background: #fee2e2; color: #dc2626; }
.pill.finished { background: #f1f5f9; color: #94a3b8; }
.pill.upcoming { background: #e0f2fe; color: #0369a1; }
tbody tr.live,
tbody tr.live td {
  color: #dc2626;
}
tbody tr.live .c-poly a,
tbody tr.live .c-link a {
  color: #b91c1c;
}
.empty {
  text-align: center;
  color: var(--muted);
  padding: 36px 10px !important;
}
.clog-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(15, 23, 42, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.clog-panel {
  width: min(860px, 100%);
  max-height: min(86vh, 900px);
  display: flex;
  flex-direction: column;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 12px;
  border: 1px solid #334155;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
}
.clog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #334155;
  background: #1e293b;
}
.clog-title { font-size: 15px; font-weight: 800; }
.clog-sub { margin-top: 2px; font-size: 11px; color: #94a3b8; word-break: break-all; }
.clog-actions { display: flex; gap: 8px; }
.clog-err { margin: 10px 14px; color: #fca5a5; font-size: 13px; }
.clog-msg { margin: 10px 14px; color: #94a3b8; font-size: 13px; }
.clog-pre {
  flex: 1;
  margin: 0;
  padding: 12px 14px 16px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cbd5e1;
}
.orders-panel {
  width: min(760px, 100%);
  max-height: min(86vh, 900px);
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #0b1220 0%, #111827 48%, #0f172a 100%);
  color: #e2e8f0;
  border-radius: 16px;
  border: 1px solid #334155;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
.orders-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(51, 65, 85, 0.9);
  background: linear-gradient(180deg, #1e293b 0%, #172033 100%);
}
.orders-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.orders-badge {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #7dd3fc;
  background: rgba(14, 165, 233, 0.15);
  border: 1px solid rgba(56, 189, 248, 0.35);
  border-radius: 999px;
  padding: 2px 8px;
}
.orders-title {
  margin: 0;
  font-size: 16px;
  font-weight: 800;
  color: #f8fafc;
}
.orders-sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: #94a3b8;
}
.orders-sub b { color: #e2e8f0; font-weight: 700; }
.orders-head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.obtn {
  appearance: none;
  border: 1px solid #475569;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
.obtn:hover:not(:disabled) { background: #1e293b; border-color: #64748b; }
.obtn:disabled { opacity: 0.45; cursor: not-allowed; }
.obtn.danger {
  border-color: #9f1239;
  background: rgba(136, 19, 55, 0.35);
  color: #fecdd3;
}
.obtn.danger:hover:not(:disabled) {
  background: rgba(190, 18, 60, 0.45);
  border-color: #fb7185;
}
.orders-err {
  margin: 0;
  padding: 10px 16px;
  color: #fecaca;
  background: rgba(127, 29, 29, 0.35);
  font-size: 12px;
  border-bottom: 1px solid #7f1d1d;
}
.orders-empty {
  padding: 48px 20px;
  text-align: center;
  color: #94a3b8;
  font-size: 14px;
}
.orders-empty-ico {
  font-size: 28px;
  opacity: 0.55;
  margin-bottom: 8px;
}
.orders-empty-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #64748b;
}
.orders-list {
  flex: 1;
  overflow: auto;
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.order-card {
  position: relative;
  border: 1px solid #334155;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.98));
  padding: 12px 12px 11px;
  box-shadow: inset 0 1px 0 rgba(148, 163, 184, 0.08);
}
.order-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: #64748b;
}
.order-card.buy::before { background: #38bdf8; }
.order-card.sell::before { background: #fb923c; }
.order-card.fail::before { background: #f87171; }
.order-card.fail {
  border-color: rgba(248, 113, 113, 0.45);
  background: linear-gradient(135deg, rgba(69, 10, 10, 0.55), rgba(15, 23, 42, 0.98));
}
.order-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-left: 6px;
}
.order-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ochip {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(51, 65, 85, 0.9);
  color: #e2e8f0;
  font-size: 11px;
  font-weight: 650;
}
.ochip.time {
  background: transparent;
  color: #94a3b8;
  padding-left: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.ochip.buy { background: rgba(14, 165, 233, 0.2); color: #7dd3fc; }
.ochip.sell { background: rgba(234, 88, 12, 0.22); color: #fdba74; }
.ochip.side { background: rgba(99, 102, 241, 0.22); color: #c7d2fe; }
.ochip.fail { background: rgba(239, 68, 68, 0.25); color: #fecaca; }
.ochip.sold { background: rgba(100, 116, 139, 0.35); color: #cbd5e1; }
.order-card-acts {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
}
.order-sell {
  appearance: none;
  flex-shrink: 0;
  border: 1px solid rgba(251, 146, 60, 0.45);
  background: rgba(154, 52, 18, 0.35);
  color: #fdba74;
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
.order-sell:hover:not(:disabled) {
  background: rgba(194, 65, 12, 0.55);
  border-color: #fb923c;
}
.order-sell:disabled { opacity: 0.45; cursor: not-allowed; }
.order-del {
  appearance: none;
  flex-shrink: 0;
  border: 1px solid rgba(248, 113, 113, 0.35);
  background: rgba(127, 29, 29, 0.25);
  color: #fecaca;
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
.order-del:hover:not(:disabled) {
  background: rgba(185, 28, 28, 0.45);
  border-color: #f87171;
}
.order-del:disabled { opacity: 0.45; cursor: not-allowed; }
.order-match {
  margin-top: 8px;
  padding-left: 6px;
  font-size: 14px;
  font-weight: 700;
  color: #f8fafc;
  line-height: 1.35;
}
.order-foot {
  margin-top: 8px;
  padding-left: 6px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  font-size: 12px;
  color: #94a3b8;
}
.order-amt {
  font-weight: 700;
  color: #cbd5e1;
  font-variant-numeric: tabular-nums;
}
.order-err { color: #fca5a5; }
.order-oid {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.ccollect-panel {
  width: min(420px, 100%);
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 12px;
  border: 1px solid #334155;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
}
.ccollect-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ccollect-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.ccollect-k {
  font-weight: 700;
  color: #e2e8f0;
}
.ccollect-hint {
  font-size: 11px;
  color: #94a3b8;
}
.ccollect-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
}
.ccollect-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 650;
  color: #e2e8f0;
  cursor: pointer;
  user-select: none;
}
.ccollect-check input {
  width: 14px;
  height: 14px;
  accent-color: #0ea5e9;
}
.ccollect-ms {
  position: relative;
}
.ccollect-ms-btn {
  width: 100%;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-radius: 8px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #f8fafc;
  padding: 0 10px;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.ccollect-ms-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ccollect-ms-caret {
  color: #94a3b8;
  font-size: 12px;
}
.ccollect-ms.open .ccollect-ms-btn {
  border-color: #38bdf8;
}
.ccollect-ms-menu {
  position: absolute;
  z-index: 5;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  border-radius: 8px;
  border: 1px solid #475569;
  background: #1e293b;
  padding: 6px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
}
.ccollect-ms-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 650;
  color: #e2e8f0;
  cursor: pointer;
}
.ccollect-ms-item:hover {
  background: #334155;
}
.ccollect-ms-item input {
  width: 14px;
  height: 14px;
  accent-color: #0ea5e9;
}
.ccollect-field select {
  height: 34px;
  border-radius: 8px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #f8fafc;
  padding: 0 10px;
  font-size: 13px;
}
.ccollect-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px 14px;
  border-top: 1px solid #334155;
  background: #1e293b;
}
</style>
