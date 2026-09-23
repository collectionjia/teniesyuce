<script setup>
/**
 * Dota2 盘口看板：对齐网球「未开赛」体验
 * Polymarket → dota2elo 筛选 → 列表 / 详情 / 自动投注（仅 HC）
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import TennisBoardBatchBar from './tennis-board/TennisBoardBatchBar.vue'
import api from '../api'

const props = defineProps({
  sport: { type: String, default: 'dota2' },
  isMember: { type: Boolean, default: false },
  canBatchTrade: { type: Boolean, default: false },
  /** 仅管理员可见/设置列表条件 */
  isAdmin: { type: Boolean, default: false },
})

const emit = defineEmits(['auto-bet-change', 'placed-orders-change', 'need-subscribe'])

const sport = computed(() => (props.sport === 'nfl' ? 'nfl' : 'dota2'))
const AUTO_BET_KEY = computed(() => `yuce.${sport.value}.autoBet.v1`)
const BATCH_AMOUNT_KEY = computed(() => `yuce.${sport.value}.batchAmountUsd.v1`)
const AUTO_PLACED_KEY = computed(() => `yuce.${sport.value}.autoPlaced.v1`)
const COND_KEY = computed(() => `yuce.${sport.value}.condition.v1`)
const POLL_MS = 45_000
const PAGE_SIZE = 5

const loading = ref(false)
const refreshing = ref(false)
const error = ref('')
const marketMeta = ref(null)
const marketRows = ref([])
const detailMatch = ref(null)
const detailHelpOpen = ref(false)
const conditionModalOpen = ref(false)
/** 启用后列表按下方参数筛「过线」 */
const condOn = ref(false)
const condEloDiff = ref('150')
const condWinPct = ref('65')
const DETAIL_TIPS = [
  { k: '优', t: 'Elo 胜率更高的一侧。' },
  { k: '一致', t: 'Elo 看好的一边和 Polymarket 价格更高的一边相同。' },
  { k: '不一致', t: 'Elo 方向和 Polymarket 高价方向相反。' },
  { k: 'Elo', t: '模型给出的胜率。卡片上方数字是该侧 Elo 分。' },
  { k: 'Elo差', t: '双方 Elo 分差的绝对值。' },
  { k: 'polymarket赔率', t: 'Polymarket 隐含占比，价格换算成百分数。' },
  { k: '外', t: '已匹配到 Polymarket 赛事页。' },
]
const currentPage = ref(1)
  /** all | matched | edge | hc — 顶栏条件过滤，默认全量采集 */
  const listFilter = ref('all')
  /** time | prob — 列表排序 */
  const listSort = ref('prob')

const autoSimBetEnabled = ref(false)
const batchAmountUsd = ref('1')
const batchSubmitting = ref(false)
const batchNotice = ref('')
const batchError = ref('')
const selectedIds = ref(new Set())
const autoPlacedIds = ref(new Set())
const placedOrders = ref([])
const manualOrderType = ref('market')
const manualSide = ref('suggest') // suggest | home(a) | away(b)
const manualShares = ref('10')
const manualLimitBuyPrice = ref('0.55')

let pollTimer = null
let autoBetRunning = false

const allowBatchTrade = computed(() => {
  if (props.canBatchTrade) return true
  if (props.isMember) return true
  return false
})

const showManualTradeOpts = computed(() => allowBatchTrade.value)

const showAutoBetBar = computed(() => props.canBatchTrade || props.isMember)

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${(Number(n) * 100).toFixed(1)}%`
}

function num(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return String(Math.round(Number(n)))
}

function fmtTime(ms) {
  if (ms == null || ms === '') return '—'
  const d = new Date(typeof ms === 'number' ? ms : Date.parse(ms))
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isStartSameDay(ms) {
  if (ms == null) return false
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return false
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

function placeKeyOf(slug, side) {
  return `${slug}:${side}`
}

function placeKey(m) {
  return placeKeyOf(m.slug, m.pickSide)
}

/** suggest→优侧；home→A；away→B（对齐网球 Up/Down） */
function resolveTradeSide(m, { manual = false } = {}) {
  if (manual) {
    if (manualSide.value === 'home') return 'a'
    if (manualSide.value === 'away') return 'b'
  }
  return m?.pickSide || null
}

function tokenForSide(m, side) {
  if (!m || !side) return null
  if (side === m.pickSide && m.pickTokenId) return m.pickTokenId
  const tokens = Array.isArray(m.tokenIds) ? m.tokenIds : []
  return side === 'a' ? (tokens[0] || null) : (tokens[1] || null)
}

function normalizeRows(raw) {
  return (Array.isArray(raw) ? raw : []).map((m) => ({
    ...m,
    id: m.slug || m.id,
    home: m.sideA || m.teamA?.name || '—',
    away: m.sideB || m.teamB?.name || '—',
    startTimestamp: m.startMs || null,
  }))
}

function loadPersisted() {
  try {
    autoSimBetEnabled.value = localStorage.getItem(AUTO_BET_KEY.value) === '1'
    const amt = Number(localStorage.getItem(BATCH_AMOUNT_KEY.value))
    if (Number.isFinite(amt) && amt >= 1) batchAmountUsd.value = String(amt)
    const placed = JSON.parse(localStorage.getItem(AUTO_PLACED_KEY.value) || '[]')
    if (Array.isArray(placed)) {
      placedOrders.value = placed.slice(-200)
      autoPlacedIds.value = new Set(placed.map((r) => r.id || placeKey(r)).filter(Boolean))
    }
    const cond = JSON.parse(localStorage.getItem(COND_KEY.value) || 'null')
    if (cond && typeof cond === 'object') {
      condOn.value = !!cond.on
      if (cond.eloDiffMin != null) condEloDiff.value = String(cond.eloDiffMin)
      if (cond.winProbMin != null) {
        const w = Number(cond.winProbMin)
        condWinPct.value = String(w > 0 && w <= 1 ? Math.round(w * 100) : Math.round(w))
      }
    }
  } catch {
    autoSimBetEnabled.value = false
  }
  emit('auto-bet-change', !!autoSimBetEnabled.value)
}

function savePersisted() {
  try {
    localStorage.setItem(AUTO_BET_KEY.value, autoSimBetEnabled.value ? '1' : '0')
    localStorage.setItem(BATCH_AMOUNT_KEY.value, String(Number(batchAmountUsd.value) || 1))
    localStorage.setItem(AUTO_PLACED_KEY.value, JSON.stringify(placedOrders.value.slice(-200)))
    localStorage.setItem(COND_KEY.value, JSON.stringify({
      on: !!condOn.value,
      eloDiffMin: Number(condEloDiff.value) || 150,
      winProbMin: (Number(condWinPct.value) || 65) / 100,
    }))
  } catch { /* ignore */ }
}

function notifyPlaced() {
  emit('placed-orders-change', placedOrders.value.map((r) => ({ ...r })))
}

const stats = computed(() => {
  const rows = marketRows.value
  const matched = rows.filter((m) => isMatchedRow(m)).length
  const hc = rows.filter((m) => m.is_high_confidence || m.passAutoBet).length
  const edge = rows.filter((m) => passesEdge(m)).length
  const date = marketMeta.value?.fetched_at
    ? fmtTime(marketMeta.value.fetched_at)
    : '—'
  return {
    date,
    shown: filteredRows.value.length,
    all: rows.length,
    tournaments: 1,
    collected: marketMeta.value?.scanned ?? rows.length,
    matched: marketMeta.value?.matchedCount ?? matched,
    edge,
    live: 0,
    ended: 0,
    hc: marketMeta.value?.hcCount ?? hc,
  }
})

function isMatchedRow(m) {
  return m?.matched !== false && m?.pA != null
}

function activeThresholds() {
  const elo = Number(condEloDiff.value)
  const winPct = Number(condWinPct.value)
  const fromMeta = marketMeta.value?.thresholds
  return {
    eloDiffMin: Number.isFinite(elo) && elo > 0 ? elo : (fromMeta?.eloDiffMin ?? 150),
    winProbMin: Number.isFinite(winPct) && winPct > 0
      ? Math.min(0.99, winPct > 1 ? winPct / 100 : winPct)
      : (fromMeta?.winProbMin ?? 0.65),
  }
}

/** 过线：HC，或 Elo差/胜率达到条件设置 */
function passesEdge(m) {
  if (!isMatchedRow(m)) return false
  if (m.is_high_confidence || m.passAutoBet) return true
  const thr = activeThresholds()
  const eloDiff = Number(m.eloDiff)
  const strong = Number(m.strongProb)
  return (Number.isFinite(eloDiff) && eloDiff >= thr.eloDiffMin)
    || (Number.isFinite(strong) && strong >= thr.winProbMin)
}

const filteredRows = computed(() => {
  let rows = marketRows.value
  if (condOn.value) rows = rows.filter(passesEdge)
  const mode = listFilter.value
  if (mode === 'matched') rows = rows.filter(isMatchedRow)
  else if (mode === 'edge') rows = rows.filter(passesEdge)
  else if (mode === 'hc') rows = rows.filter((m) => m.is_high_confidence || m.passAutoBet)
  const sorted = [...rows]
  if (listSort.value === 'time') {
    sorted.sort((a, b) => (a.startMs || a.startTimestamp || 0) - (b.startMs || b.startTimestamp || 0))
  } else {
    sorted.sort((a, b) => (Number(b.strongProb) || 0) - (Number(a.strongProb) || 0))
  }
  return sorted
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / PAGE_SIZE)))

const paginatedMatches = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return filteredRows.value.slice(start, start + PAGE_SIZE)
})

const pageSelectable = computed(() => paginatedMatches.value.filter((m) => canSelectMatch(m)))

const pageAllSelected = computed(() => {
  const list = pageSelectable.value
  return list.length > 0 && list.every((m) => selectedIds.value.has(String(m.id)))
})

const selectedCount = computed(() => selectedIds.value.size)

const emptyListHint = computed(() => {
  const label = sport.value === 'nfl' ? 'NFL' : 'DOTA2'
  // 有采集结果但被条件/筛选滤空
  if (marketRows.value.length && !filteredRows.value.length) {
    return condOn.value
      ? '按当前条件暂时没有可跟的场次。可以适当放宽门槛，或先关掉条件过滤，看看全部盘口。'
      : '当前筛选下没有场次。试试切换筛选，或稍后再来看新开的盘。'
  }
  // 已扫描但列表为空
  if ((marketMeta.value?.scanned || 0) > 0) {
    return `刚巡检过 ${label} 相关盘口，眼下还没有足够清晰的推荐方向。新比赛会随开盘陆续出现，过一会儿刷新通常就能看到。`
  }
  // 完全无数据：产品向说明
  return `暂时还没有可推荐的 ${label} 比赛。盘口一般会在开赛前陆续放出，建议稍后再刷新，或关注临近开赛的时段——有合适对阵时会第一时间出现在这里。`
})

const condSummary = computed(() => {
  const thr = activeThresholds()
  return `${condOn.value ? '已启用' : '未启用'} · Elo≥${thr.eloDiffMin} 或 胜率≥${pct(thr.winProbMin)}`
})

function setListFilter(mode) {
  if (listFilter.value === mode) return
  listFilter.value = mode
  currentPage.value = 1
  clearSelection()
}

function setListSort(mode) {
  if (listSort.value === mode) return
  listSort.value = mode
  currentPage.value = 1
}

function openConditionModal() {
  if (!props.isAdmin) return
  const t = marketMeta.value?.thresholds
  if (t && !localStorage.getItem(COND_KEY.value)) {
    if (t.eloDiffMin != null) condEloDiff.value = String(t.eloDiffMin)
    if (t.winProbMin != null) condWinPct.value = String(Math.round(Number(t.winProbMin) * 100))
  }
  conditionModalOpen.value = true
}

function closeConditionModal() {
  conditionModalOpen.value = false
}

function applyConditionSettings() {
  savePersisted()
  currentPage.value = 1
  clearSelection()
  conditionModalOpen.value = false
}

function pmPrice(m, side) {
  const i = side === 'a' ? 0 : 1
  const v = m?.prices?.[i]
  return v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—'
}

function sideProb(m, side) {
  const pA = Number(m?.pA)
  if (!Number.isFinite(pA)) return '—'
  return side === 'a' ? pct(pA) : pct(1 - pA)
}

function isSelected(m) {
  return selectedIds.value.has(String(m.id))
}

function canSelectMatch(m) {
  if (!allowBatchTrade.value) return false
  const side = resolveTradeSide(m, { manual: true })
  const tokenId = tokenForSide(m, side)
  if (!m?.slug || !side || !tokenId) return false
  if (autoPlacedIds.value.has(placeKeyOf(m.slug, side)) || autoPlacedIds.value.has(String(m.id))) {
    return false
  }
  return true
}

function toggleSelect(m) {
  if (!canSelectMatch(m)) return
  const id = String(m.id)
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleSelectPage() {
  const list = pageSelectable.value
  const next = new Set(selectedIds.value)
  if (pageAllSelected.value) {
    for (const m of list) next.delete(String(m.id))
  } else {
    for (const m of list) next.add(String(m.id))
  }
  selectedIds.value = next
}

function clearSelection() {
  selectedIds.value = new Set()
}

function goPage(p) {
  currentPage.value = Math.min(totalPages.value, Math.max(1, p))
}

function openDetail(m) {
  if (!props.isMember) {
    emit('need-subscribe')
    return
  }
  detailHelpOpen.value = false
  detailMatch.value = m
}

function closeDetail() {
  detailMatch.value = null
  detailHelpOpen.value = false
}

function toggleDetailHelp(e) {
  e?.stopPropagation?.()
  detailHelpOpen.value = !detailHelpOpen.value
}

function pmCents(m, side) {
  const v = Number(m?.prices?.[side === 'a' ? 0 : 1])
  return Number.isFinite(v) ? String(Math.round(v * 100)) : '—'
}

function openMarket(m) {
  if (!props.isMember) {
    emit('need-subscribe')
    return
  }
  const url = m?.url
  if (url) window.open(url, '_blank', 'noopener')
}

async function loadMarkets({ quiet = false } = {}) {
  if (!quiet) {
    loading.value = true
    error.value = ''
  }
  try {
    const { data } = await api.get(`/${sport.value}/markets`)
    marketMeta.value = data
    marketRows.value = normalizeRows(data?.matches)
    const serverPlaced = Array.isArray(data?.placed) ? data.placed : []
    if (serverPlaced.length) {
      const next = new Set(autoPlacedIds.value)
      for (const k of serverPlaced) next.add(String(k))
      autoPlacedIds.value = next
    }
    if (currentPage.value > totalPages.value) currentPage.value = 1
  } catch (e) {
    if (!quiet) {
      error.value = e?.response?.data?.error || e.message || '加载盘口失败'
      marketRows.value = []
    }
  } finally {
    if (!quiet) loading.value = false
  }
}

async function refreshCollect() {
  refreshing.value = true
  error.value = ''
  batchError.value = ''
  try {
    const { data } = await api.post(`/${sport.value}/markets/refresh`)
    marketMeta.value = data
    marketRows.value = normalizeRows(data?.matches)
    await loadMarkets({ quiet: true })
    batchNotice.value = `已刷新 · ${marketRows.value.length} 场`
    if (autoSimBetEnabled.value) void runAutoBet()
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '刷新失败'
  } finally {
    refreshing.value = false
  }
}

function toggleAutoBet() {
  if (!allowBatchTrade.value) {
    batchError.value = '需会员并配置钱包后才能自动投注'
    return
  }
  autoSimBetEnabled.value = !autoSimBetEnabled.value
  savePersisted()
  emit('auto-bet-change', !!autoSimBetEnabled.value)
  batchNotice.value = autoSimBetEnabled.value
    ? '已开启自动投注（仅高置信度市价买入）'
    : '已关闭自动投注'
  if (autoSimBetEnabled.value) void runAutoBet()
}

function buildOrdersFromMatches(list, amount, { manual = false } = {}) {
  return list
    .map((m) => {
      const side = resolveTradeSide(m, { manual })
      const tokenId = tokenForSide(m, side)
      if (!m.slug || !side || !tokenId) return null
      if (autoPlacedIds.value.has(placeKeyOf(m.slug, side))) return null
      return {
        slug: m.slug,
        side,
        tokenId,
        amountUsd: amount,
        id: m.id,
        label: `${m.home} vs ${m.away}`,
        pickName: side === 'a' ? m.home : m.away,
      }
    })
    .filter(Boolean)
}

async function placeOrders(orders, { auto = false } = {}) {
  if (!orders.length) return
  if (!allowBatchTrade.value) {
    batchError.value = '无法下单：请确认会员与钱包'
    return
  }
  const amount = Math.round(Number(batchAmountUsd.value) * 100) / 100
  const orderType = (!auto && manualOrderType.value === 'limit') ? 'limit' : 'market'

  if (orderType === 'market' && !(amount >= 1)) {
    batchError.value = '投注金额至少 $1'
    return
  }

  const payload = {
    orders: orders.map((o) => ({
      slug: o.slug,
      side: o.side,
      tokenId: o.tokenId,
      amountUsd: amount,
    })),
    amountUsd: amount,
    orderType,
  }

  if (orderType === 'limit') {
    const shares = Math.floor(Number(manualShares.value) * 100) / 100
    const lp = Number(manualLimitBuyPrice.value)
    if (!(shares > 0)) {
      batchError.value = '限价单须填写份额'
      return
    }
    if (!(lp >= 0.01 && lp <= 0.99)) {
      batchError.value = '买入目标价须在 0.01–0.99'
      return
    }
    payload.shares = shares
    payload.limitBuyPrice = Math.round(lp * 100) / 100
    payload.limitPrice = payload.limitBuyPrice
  }
  if (!auto && (manualSide.value === 'home' || manualSide.value === 'away')) {
    payload.allowAnySide = true
  }

  batchSubmitting.value = true
  batchError.value = ''
  if (!auto) batchNotice.value = ''
  try {
    const { data: resp } = await api.post(`/${sport.value}/trade/batch`, payload)
    const results = Array.isArray(resp?.results) ? resp.results : []
    let ok = 0
    let skip = 0
    let fail = 0
    const nextPlaced = new Set(autoPlacedIds.value)
    const nextOrders = [...placedOrders.value]
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i]
      const src = orders[i]
      const key = r.slug && r.side
        ? placeKeyOf(r.slug, r.side)
        : (src ? placeKeyOf(src.slug, src.side) : '')
      if (r.ok && r.skipped) {
        skip += 1
        if (key) nextPlaced.add(key)
        if (src?.id) nextPlaced.add(String(src.id))
      } else if (r.ok) {
        ok += 1
        if (key) nextPlaced.add(key)
        if (src?.id) nextPlaced.add(String(src.id))
        nextOrders.push({
          id: key || String(src?.id),
          label: src?.label || key,
          side: r.side,
          amountUsd: amount,
          orderType,
          at: Date.now(),
          pickName: src?.pickName,
        })
      } else {
        fail += 1
      }
    }
    autoPlacedIds.value = nextPlaced
    placedOrders.value = nextOrders.slice(-200)
    savePersisted()
    notifyPlaced()
    clearSelection()
    const kind = orderType === 'limit' ? '限价' : '市价'
    batchNotice.value = `${auto ? '自动' : '手动'}${kind}：成功 ${ok} · 跳过 ${skip} · 失败 ${fail}`
    const firstErr = results.find((r) => !r.ok)?.error
    if (fail && firstErr) batchError.value = firstErr
  } catch (e) {
    batchError.value = e?.response?.data?.error || e.message || '下单失败'
  } finally {
    batchSubmitting.value = false
  }
}

async function submitBatchTrade() {
  const selected = marketRows.value.filter((m) => selectedIds.value.has(String(m.id)))
  const orders = buildOrdersFromMatches(selected, Number(batchAmountUsd.value), { manual: true })
  if (!orders.length) {
    batchError.value = '请先勾选可下单场次'
    return
  }
  await placeOrders(orders, { auto: false })
}

async function runAutoBet() {
  if (!autoSimBetEnabled.value || !allowBatchTrade.value || autoBetRunning || batchSubmitting.value) return
  const hc = marketRows.value.filter((m) => m.passAutoBet || m.is_high_confidence)
  const orders = buildOrdersFromMatches(hc, Number(batchAmountUsd.value), { manual: false }).slice(0, 10)
  if (!orders.length) return
  autoBetRunning = true
  try {
    await placeOrders(orders, { auto: true })
  } finally {
    autoBetRunning = false
  }
}

function syncPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollTimer = setInterval(async () => {
    await loadMarkets({ quiet: true })
    if (autoSimBetEnabled.value) void runAutoBet()
  }, POLL_MS)
}

watch(batchAmountUsd, () => savePersisted())
watch(manualSide, () => {
  clearSelection()
})
watch(sport, async () => {
  loadPersisted()
  currentPage.value = 1
  clearSelection()
  await loadMarkets()
})

onMounted(async () => {
  loadPersisted()
  await loadMarkets()
  if (autoSimBetEnabled.value) void runAutoBet()
  syncPoll()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

defineExpose({
  getPlacedOrders: () => placedOrders.value.map((r) => ({ ...r })),
})
</script>

<template>
  <div class="wrap">
    <div class="topbar">
      <span class="meta-chip">{{ stats.date }}</span>
      <span class="meta-chip">{{ loading ? '…' : `${stats.shown}/${stats.collected || stats.all}` }}</span>
      <button
        type="button"
        class="btn ghost"
        :disabled="loading || refreshing"
        @click="refreshCollect"
      >{{ refreshing ? '采集中…' : '刷新' }}</button>
      <button
        v-if="isAdmin"
        type="button"
        class="btn ghost"
        :class="{ on: condOn }"
        @click="openConditionModal"
      >条件设置</button>
      <div class="stats" role="tablist" aria-label="条件过滤">
        <button type="button" class="stat" :class="{ active: listFilter === 'all' }" @click="setListFilter('all')">
          <b>{{ stats.collected }}</b><span>扫</span>
        </button>
        <button type="button" class="stat" :class="{ active: listFilter === 'matched' }" @click="setListFilter('matched')">
          <b>{{ stats.matched }}</b><span>匹配</span>
        </button>
        <button type="button" class="stat" :class="{ active: listFilter === 'edge' }" @click="setListFilter('edge')">
          <b>{{ stats.edge }}</b><span>过线</span>
        </button>
        <button type="button" class="stat" :class="{ active: listFilter === 'hc' }" @click="setListFilter('hc')">
          <b>{{ stats.hc }}</b><span>HC</span>
        </button>
      </div>
      <div class="stats sort-stats" role="tablist" aria-label="排序">
        <button type="button" class="stat" :class="{ active: listSort === 'time' }" @click="setListSort('time')">
          <span>时间排序</span>
        </button>
        <button type="button" class="stat" :class="{ active: listSort === 'prob' }" @click="setListSort('prob')">
          <span>胜率排序</span>
        </button>
      </div>
    </div>

    <TennisBoardBatchBar
      v-if="showAutoBetBar"
      :allow-batch-trade="allowBatchTrade"
      :auto-sim-bet-enabled="autoSimBetEnabled"
      :page-all-selected="pageAllSelected"
      :page-selectable="pageSelectable"
      :selected-count="selectedCount"
      v-model:batch-amount-usd="batchAmountUsd"
      :show-manual-trade-opts="showManualTradeOpts"
      v-model:manual-order-type="manualOrderType"
      v-model:manual-side="manualSide"
      v-model:manual-shares="manualShares"
      v-model:manual-limit-buy-price="manualLimitBuyPrice"
      :batch-submitting="batchSubmitting"
      :batch-notice="batchNotice"
      :batch-error="batchError"
      :toggle-auto-bet="toggleAutoBet"
      :toggle-select-page="toggleSelectPage"
      :submit-batch-trade="submitBatchTrade"
      :clear-selection="clearSelection"
    />

    <div v-if="loading && !marketRows.length" class="empty">加载盘口中…</div>
    <div v-else-if="error && !marketRows.length" class="empty err">{{ error }}</div>
    <div v-else-if="!filteredRows.length" class="empty empty-copy" role="status">
      {{ emptyListHint }}
    </div>
    <template v-else>
      <div class="list">
        <article
          v-for="m in paginatedMatches"
          :key="m.id"
          class="row-card"
          :class="{ selected: isSelected(m), selectable: canSelectMatch(m), teaser: !isMember }"
          @click="!isMember && emit('need-subscribe')"
        >
          <label
            v-if="allowBatchTrade"
            class="row-check"
            :class="{ disabled: !canSelectMatch(m) }"
          >
            <input
              type="checkbox"
              :checked="isSelected(m)"
              :disabled="!canSelectMatch(m)"
              @change="toggleSelect(m)"
            />
          </label>
          <span
            v-if="allowBatchTrade && (autoPlacedIds.has(placeKey(m)) || autoPlacedIds.has(String(m.id)))"
            class="placed-badge"
          >已下</span>
          <div class="row-body">
            <div class="row-time">
              <span class="start-value" :class="{ today: isStartSameDay(m.startTimestamp) }">
                {{ fmtTime(m.startTimestamp) }}
              </span>
              <span class="start-status">未开</span>
              <span v-if="isMember" class="tour-title">差 {{ num(m.eloDiff) }}</span>
              <div v-if="isMember" class="badges">
                <span v-if="!isMatchedRow(m)" class="badge raw">未匹配</span>
                <span v-if="m.is_high_confidence" class="badge hc">HC</span>
                <span v-else-if="passesEdge(m)" class="badge edge">过线</span>
                <span v-if="m.url" class="badge poly">外</span>
                <span v-if="m.pickSide" class="badge pick">优</span>
                <span v-if="m.align" class="badge" :class="m.align === '一致' ? 'agree' : 'disagree'">{{ m.align }}</span>
              </div>
            </div>
            <div class="row-main">
              <div class="matchup is-stacked">
                <div class="matchup-line">
                  <span class="name" :class="{ pick: isMember && m.pickSide === 'a' }">
                    <span v-if="isMember" class="list-rank">{{ num(m.teamA?.rating) }}</span>
                    <span class="player-name">{{ m.home }}</span>
                    <span v-if="isMember && m.pickSide === 'a'" class="pick-tag">优</span>
                  </span>
                  <span v-if="isMember" class="side-nums">
                    <em :class="{ pick: m.pickSide === 'a' }">{{ sideProb(m, 'a') }}</em>
                    <em class="pm">{{ pmPrice(m, 'a') }}</em>
                  </span>
                </div>
                <span class="vs-row">VS</span>
                <div class="matchup-line">
                  <span class="name" :class="{ pick: isMember && m.pickSide === 'b' }">
                    <span v-if="isMember" class="list-rank">{{ num(m.teamB?.rating) }}</span>
                    <span class="player-name">{{ m.away }}</span>
                    <span v-if="isMember && m.pickSide === 'b'" class="pick-tag">优</span>
                  </span>
                  <span v-if="isMember" class="side-nums">
                    <em :class="{ pick: m.pickSide === 'b' }">{{ sideProb(m, 'b') }}</em>
                    <em class="pm">{{ pmPrice(m, 'b') }}</em>
                  </span>
                </div>
              </div>
          <div v-if="isMember" class="row-actions">
            <button type="button" class="act-btn" @click="openDetail(m)">参数详情</button>
            <button
              type="button"
              class="act-btn market"
              :disabled="!m.url"
              @click="openMarket(m)"
            >跳转下单</button>
          </div>
          <div v-else class="row-actions">
            <button type="button" class="act-btn unlock" @click.stop="emit('need-subscribe')">开通查看</button>
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
              <div class="modal-title">参数详情</div>
              <div class="modal-sub">{{ detailMatch.home }} vs {{ detailMatch.away }}</div>
              <div class="modal-meta">
                <span>{{ detailMatch.title || (sport === 'nfl' ? 'NFL' : 'Dota2') }}</span>
                · <span :class="{ today: isStartSameDay(detailMatch.startTimestamp) }">{{ fmtTime(detailMatch.startTimestamp) }}</span>
                · 未开
              </div>
              <div class="badges modal-badges">
                <span v-if="!isMatchedRow(detailMatch)" class="badge raw">未匹配</span>
                <span v-if="detailMatch.is_high_confidence" class="badge hc">HC</span>
                <span v-else-if="passesEdge(detailMatch)" class="badge edge">过线</span>
                <span v-if="detailMatch.url" class="badge poly">外</span>
                <span v-if="detailMatch.pickSide" class="badge pick">优{{ detailMatch.pickSide === 'a' ? detailMatch.home : detailMatch.away }}</span>
                <span v-if="detailMatch.align" class="badge" :class="detailMatch.align === '一致' ? 'agree' : 'disagree'">{{ detailMatch.align }}</span>
              </div>
            </div>
            <div class="modal-head-actions">
              <button
                type="button"
                class="help-bang modal-help-bang"
                :class="{ on: detailHelpOpen }"
                title="字段说明"
                aria-label="字段说明"
                @click="toggleDetailHelp"
              >!</button>
              <button type="button" class="modal-x" aria-label="关闭" @click="closeDetail">×</button>
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
              <div class="duel-side" :class="{ pick: detailMatch.pickSide === 'a' }">
                <div class="duel-top">
                  <span class="duel-rank">{{ num(detailMatch.teamA?.rating) }}</span>
                </div>
                <div class="duel-name">
                  {{ detailMatch.home }}
                  <span v-if="detailMatch.pickSide === 'a'" class="pick-tag">优</span>
                </div>
                <div class="duel-sub" :class="{ pick: detailMatch.pickSide === 'a' }">胜率 {{ sideProb(detailMatch, 'a') }}</div>
              </div>
              <div class="duel-vs">VS</div>
              <div class="duel-side" :class="{ pick: detailMatch.pickSide === 'b' }">
                <div class="duel-top">
                  <span class="duel-rank">{{ num(detailMatch.teamB?.rating) }}</span>
                </div>
                <div class="duel-name">
                  {{ detailMatch.away }}
                  <span v-if="detailMatch.pickSide === 'b'" class="pick-tag">优</span>
                </div>
                <div class="duel-sub" :class="{ pick: detailMatch.pickSide === 'b' }">胜率 {{ sideProb(detailMatch, 'b') }}</div>
              </div>
            </div>

            <div class="kv-grid">
              <div class="kv">
                <span class="k">Elo差</span>
                <span class="v rank-curr">{{ num(detailMatch.eloDiff) }}</span>
                <span class="s">{{ num(detailMatch.teamA?.rating) }} − {{ num(detailMatch.teamB?.rating) }}</span>
              </div>
              <div class="kv">
                <span class="k">方向</span>
                <span class="v" :class="detailMatch.align === '一致' ? 'rank-curr' : 'rank-best'">{{ detailMatch.align || '—' }}</span>
                <span class="s">Elo 与 Polymarket 高价侧</span>
              </div>
              <div class="kv wide">
                <span class="k">Elo</span>
                <span class="v">{{ detailMatch.pickName || '—' }} {{ sideProb(detailMatch, detailMatch.pickSide || 'a') }}</span>
                <span class="s">
                  {{ detailMatch.home }} {{ sideProb(detailMatch, 'a') }}
                  · {{ detailMatch.away }} {{ sideProb(detailMatch, 'b') }}
                  · {{ sport === 'nfl' ? 'nflelo' : 'dota2elo' }}
                </span>
              </div>
              <div v-if="detailMatch.url" class="kv">
                <span class="k">polymarket赔率</span>
                <div class="kv-lines">
                  <div class="kv-line">
                    <span class="n">{{ detailMatch.home }}</span>
                    <span class="num">{{ pmCents(detailMatch, 'a') }}</span>
                  </div>
                  <div class="kv-line">
                    <span class="n">{{ detailMatch.away }}</span>
                    <span class="num">{{ pmCents(detailMatch, 'b') }}</span>
                  </div>
                </div>
                <span class="s">隐含占比</span>
              </div>
            </div>
          </div>

          <div class="modal-foot">
            <button type="button" class="act-btn" @click="closeDetail">关闭</button>
            <button
              type="button"
              class="act-btn market"
              :disabled="!detailMatch.url"
              :title="detailMatch.url ? '打开 Polymarket' : '暂无对应外链'"
              @click="openMarket(detailMatch)"
            >polymarket赔率</button>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="conditionModalOpen && isAdmin" class="modal-mask" @click.self="closeConditionModal">
        <div class="modal-sheet cond-sheet" role="dialog" aria-modal="true" aria-label="条件设置">
          <div class="modal-head">
            <div class="modal-head-main">
              <div class="modal-title">条件设置</div>
              <div class="modal-sub">{{ sport === 'nfl' ? 'NFL' : 'Dota2' }} · {{ condSummary }}</div>
            </div>
            <div class="modal-head-actions">
              <button type="button" class="modal-x" aria-label="关闭" @click="closeConditionModal">×</button>
            </div>
          </div>
          <div class="modal-body cond-body">
            <p class="cond-hint">
              列表展示 Polymarket 采集赛事；匹配到
              {{ sport === 'nfl' ? 'nflelo' : 'dota2elo' }}
              API 后显示两侧胜率。启用条件后仅保留过线场次。
            </p>
            <label class="cond-toggle">
              <input v-model="condOn" type="checkbox">
              <span>启用条件过滤</span>
            </label>
            <label class="cond-field">
              <span>Elo 分差 ≥</span>
              <input v-model="condEloDiff" type="number" min="1" step="1" inputmode="numeric">
            </label>
            <label class="cond-field">
              <span>强队胜率 ≥ (%)</span>
              <input v-model="condWinPct" type="number" min="50" max="99" step="1" inputmode="decimal">
            </label>
            <p class="cond-hint muted">满足「Elo 分差」或「胜率」任一即过线；HC 始终算过线。自动投注仍只买 HC。</p>
          </div>
          <div class="modal-foot">
            <button type="button" class="act-btn" @click="closeConditionModal">取消</button>
            <button type="button" class="act-btn market" @click="applyConditionSettings">应用</button>
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
  color: var(--text);
  background: var(--bg);
  padding: 6px;
  border-radius: 0;
  min-height: 280px;
  max-width: 100%;
  overflow-x: hidden;
}
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  max-width: 100%;
}
.meta-chip,
.btn {
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
.btn.ghost.on {
  border-color: var(--primary);
  background: #e0e7ff;
  color: #3730a3;
  font-weight: 700;
}
.btn:disabled { opacity: 0.5; cursor: wait; }
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 3px;
  margin-left: 0;
  min-width: 0;
  flex: 1 1 148px;
  max-width: 100%;
}
.sort-stats {
  grid-template-columns: repeat(2, 1fr);
  flex: 1 1 120px;
  max-width: 160px;
}
.stat {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 4px;
  text-align: center;
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  gap: 2px;
  white-space: nowrap;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.stat b {
  color: var(--primary);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat span { color: var(--muted); font-size: 0.58rem; line-height: 1.2; }
.stat.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  box-shadow: 0 0 0 1px rgba(79, 70, 229, 0.25);
}
.stat.active span { color: #6366f1; font-weight: 600; }

.empty {
  text-align: center;
  color: var(--muted);
  padding: 16px 8px;
  font-size: 0.86rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.empty.empty-copy {
  max-width: 22rem;
  margin-left: auto;
  margin-right: auto;
  padding: 22px 16px;
  line-height: 1.6;
}
.empty.err { color: var(--danger); }
.empty .hint { margin-top: 6px; font-size: 0.68rem; opacity: 0.85; }

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
.row-check.disabled { opacity: 0.35; cursor: not-allowed; }
.row-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: inherit;
}
.placed-badge {
  flex-shrink: 0;
  margin-top: 1px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
}
.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
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
.row-time .start-value.today { color: #dc2626; }
.row-time .start-status {
  color: #64748b;
  font-size: 0.7rem;
  font-weight: 600;
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
.badges { display: flex; flex-wrap: wrap; gap: 4px; }
.badge {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 0.76rem;
  font-weight: 700;
  line-height: 1.35;
  display: inline-flex;
  align-items: center;
}
.badge.hc { background: #fffbeb; color: #b45309; }
.badge.edge { background: #ecfdf5; color: #047857; }
.badge.raw { background: #f1f5f9; color: #64748b; }
.badge.poly { background: #f5f3ff; color: #6d28d9; }
.badge.pick { background: var(--primary); color: #fff; }
.badge.agree { background: #ecfdf5; color: #047857; }
.badge.disagree { background: #fef2f2; color: #b91c1c; }
.row-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
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
  gap: 8px;
  min-width: 0;
}
.vs-row {
  color: var(--muted);
  font-size: 0.72rem;
  font-weight: 800;
  line-height: 1.1;
  padding: 1px 0;
  flex-shrink: 0;
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
  min-width: 0;
  flex: 1;
}
.matchup .name.pick { color: var(--primary); }
.player-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list-rank {
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
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
.side-nums {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-style: normal;
}
.side-nums em {
  font-style: normal;
  font-variant-numeric: tabular-nums;
  font-size: 0.78rem;
  font-weight: 700;
  color: #334155;
  min-width: 3em;
  text-align: right;
}
.side-nums em.pick { color: var(--primary); }
.side-nums em.pm { color: #64748b; min-width: 2.2em; }
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
.act-btn.unlock {
  background: #fff7ed;
  color: #c2410c;
  border-color: #fdba74;
}
.act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.row-card.teaser { cursor: pointer; }

@media (max-width: 420px) {
  .wrap { padding: 4px; }
  .row-card { padding: 6px; gap: 4px; }
  .row-main {
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .matchup.is-stacked { flex: 1 1 100%; }
  .row-actions {
    margin-left: 0;
    width: 100%;
    justify-content: flex-start;
  }
  .act-btn { padding: 5px 9px; font-size: 0.74rem; }
  .matchup .name { font-size: 0.9rem; }
  .side-nums em { font-size: 0.72rem; min-width: 2.7em; }
  .side-nums em.pm { min-width: 2em; }
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f1f5f9;
}
.pager-info {
  color: #64748b;
  font-size: 0.76rem;
  font-weight: 600;
  min-width: 5.5em;
  text-align: center;
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

.modal-mask {
  --line: #e2e8f0;
  --muted: #94a3b8;
  --primary: #4f46e5;
  --primary-soft: #eef2ff;
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12px 8px;
  overflow-y: auto;
}
.modal-sheet {
  width: 100%;
  max-width: 26rem;
  max-height: min(88vh, 720px);
  background: #fff;
  border-radius: 12px;
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
  margin-top: 4px;
  font-size: 0.72rem;
  color: #64748b;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.modal-meta .today { color: #dc2626; font-weight: 700; }
.modal-badges { margin-top: 6px; justify-content: flex-start; }
.modal-x {
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  background: #fff;
  color: #64748b;
  border-radius: 8px;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}
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
  padding: 10px 12px;
  border-bottom: 1px solid #fed7aa;
  background: #fff7ed;
  color: #9a3412;
  max-height: 40vh;
  overflow-y: auto;
}
.modal-help-title { font-size: 0.8rem; font-weight: 800; margin-bottom: 6px; }
.modal-help-list {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.72rem;
  line-height: 1.5;
  font-weight: 600;
}
.modal-help-list li { margin-bottom: 4px; }
.modal-help-list b { color: #7c2d12; }
.modal-body {
  padding: 10px 12px 12px;
  overflow-y: auto;
}
.modal-foot {
  display: flex;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px solid #f1f5f9;
}
.modal-foot .act-btn { flex: 1; padding: 10px; font-size: 0.86rem; }
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
  text-align: left;
}
.duel-side.pick {
  border-color: #c7d2fe;
  background: var(--primary-soft);
}
.duel-top { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.duel-rank {
  font-size: 0.82rem;
  font-weight: 800;
  color: #2563eb;
  font-variant-numeric: tabular-nums;
}
.duel-name {
  margin-top: 3px;
  font-size: 0.88rem;
  font-weight: 800;
  color: #0f172a;
  line-height: 1.25;
  word-break: break-word;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.duel-side.pick .duel-name { color: #3730a3; }
.duel-sub { margin-top: 3px; font-size: 0.68rem; color: #64748b; line-height: 1.35; }
.duel-sub.pick { color: var(--primary); font-weight: 700; }
.kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
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
.kv .k { font-size: 0.68rem; font-weight: 700; color: #94a3b8; letter-spacing: 0.02em; }
.kv .v {
  font-size: 0.86rem;
  font-weight: 800;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  word-break: break-word;
}
.kv .v.rank-curr { color: #2563eb; }
.kv .v.rank-best { color: #dc2626; }
.kv .s { font-size: 0.68rem; line-height: 1.35; font-weight: 600; color: #64748b; }
.kv-lines { display: grid; gap: 3px; margin-top: 1px; }
.kv-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}
.kv-line .n {
  font-size: 0.82rem;
  font-weight: 700;
  color: #334155;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-line .num { font-size: 0.88rem; font-weight: 800; color: #0f172a; flex-shrink: 0; }

.cond-sheet { max-width: 420px; }
.cond-body {
  padding: 12px 14px 8px;
  display: grid;
  gap: 10px;
}
.cond-hint {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.45;
  color: #475569;
}
.cond-hint.muted { color: #94a3b8; font-size: 0.72rem; }
.cond-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.86rem;
  font-weight: 700;
  color: #0f172a;
}
.cond-field {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  font-weight: 600;
  color: #334155;
}
.cond-field input {
  width: 96px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 0.86rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
</style>
