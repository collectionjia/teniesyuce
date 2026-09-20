<script setup>
/**
 * Dota2 盘口看板：对齐网球「未开赛」体验
 * Polymarket → dota2elo 筛选 → 列表 / 详情 / 自动投注（仅 HC）
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import TennisBoardBatchBar from './tennis-board/TennisBoardBatchBar.vue'
import {
  fetchDota2Markets,
  refreshDota2Markets,
  placeDota2TradeBatch,
} from '../api'

const props = defineProps({
  isMember: { type: Boolean, default: false },
  canBatchTrade: { type: Boolean, default: false },
})

const emit = defineEmits(['auto-bet-change', 'placed-orders-change'])

const AUTO_BET_KEY = 'yuce.dota2.autoBet.v1'
const BATCH_AMOUNT_KEY = 'yuce.dota2.batchAmountUsd.v1'
const AUTO_PLACED_KEY = 'yuce.dota2.autoPlaced.v1'
const POLL_MS = 45_000
const PAGE_SIZE = 5

const loading = ref(false)
const refreshing = ref(false)
const error = ref('')
const marketMeta = ref(null)
const marketRows = ref([])
const detailMatch = ref(null)
const currentPage = ref(1)

const autoSimBetEnabled = ref(false)
const batchAmountUsd = ref('1')
const batchSubmitting = ref(false)
const batchNotice = ref('')
const batchError = ref('')
const selectedIds = ref(new Set())
const autoPlacedIds = ref(new Set())
const placedOrders = ref([])

let pollTimer = null
let autoBetRunning = false

const allowBatchTrade = computed(() => {
  if (props.canBatchTrade) return true
  if (props.isMember) return true
  return false
})

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

function placeKey(m) {
  return `${m.slug}:${m.pickSide}`
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
    autoSimBetEnabled.value = localStorage.getItem(AUTO_BET_KEY) === '1'
    const amt = Number(localStorage.getItem(BATCH_AMOUNT_KEY))
    if (Number.isFinite(amt) && amt >= 1) batchAmountUsd.value = String(amt)
    const placed = JSON.parse(localStorage.getItem(AUTO_PLACED_KEY) || '[]')
    if (Array.isArray(placed)) {
      placedOrders.value = placed.slice(-200)
      autoPlacedIds.value = new Set(placed.map((r) => r.id || placeKey(r)).filter(Boolean))
    }
  } catch {
    autoSimBetEnabled.value = false
  }
  emit('auto-bet-change', !!autoSimBetEnabled.value)
}

function savePersisted() {
  try {
    localStorage.setItem(AUTO_BET_KEY, autoSimBetEnabled.value ? '1' : '0')
    localStorage.setItem(BATCH_AMOUNT_KEY, String(Number(batchAmountUsd.value) || 1))
    localStorage.setItem(AUTO_PLACED_KEY, JSON.stringify(placedOrders.value.slice(-200)))
  } catch { /* ignore */ }
}

function notifyPlaced() {
  emit('placed-orders-change', placedOrders.value.map((r) => ({ ...r })))
}

const stats = computed(() => {
  const rows = marketRows.value
  const hc = rows.filter((m) => m.is_high_confidence || m.passAutoBet).length
  const edge = rows.filter((m) => m.passList).length
  const date = marketMeta.value?.fetched_at
    ? fmtTime(marketMeta.value.fetched_at)
    : '—'
  return {
    date,
    shown: rows.length,
    all: rows.length,
    tournaments: 1,
    collected: marketMeta.value?.scanned ?? rows.length,
    open: rows.length,
    edge: marketMeta.value?.edgeCount ?? edge,
    live: 0,
    ended: 0,
    hc: marketMeta.value?.hcCount ?? hc,
  }
})

const totalPages = computed(() => Math.max(1, Math.ceil(marketRows.value.length / PAGE_SIZE)))

const paginatedMatches = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return marketRows.value.slice(start, start + PAGE_SIZE)
})

const pageSelectable = computed(() => paginatedMatches.value.filter((m) => canSelectMatch(m)))

const pageAllSelected = computed(() => {
  const list = pageSelectable.value
  return list.length > 0 && list.every((m) => selectedIds.value.has(String(m.id)))
})

const selectedCount = computed(() => selectedIds.value.size)

const emptyListHint = computed(() => {
  const scanned = marketMeta.value?.scanned
  if (scanned > 0 && !marketRows.value.length) {
    return `Polymarket 扫描 ${scanned} 场，暂无同时匹配 dota2elo 的场次`
  }
  return '暂无盘口（刷新采集 Polymarket Dota 对阵）'
})

const bundleHint = computed(() => {
  const t = marketMeta.value?.thresholds
  if (!t) return ''
  return `自动投注仅 HC · 过线条件 Elo≥${t.eloDiffMin} 或 胜率≥${pct(t.winProbMin)}`
})

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
  if (!m?.pickTokenId || !m?.slug || !m?.pickSide) return false
  if (autoPlacedIds.value.has(placeKey(m)) || autoPlacedIds.value.has(String(m.id))) return false
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
  detailMatch.value = m
}

function closeDetail() {
  detailMatch.value = null
}

function openMarket(m) {
  const url = m?.url
  if (url) window.open(url, '_blank', 'noopener')
}

async function loadMarkets({ quiet = false } = {}) {
  if (!quiet) {
    loading.value = true
    error.value = ''
  }
  try {
    const data = await fetchDota2Markets()
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
    const data = await refreshDota2Markets()
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

function buildOrdersFromMatches(list, amount) {
  return list
    .filter((m) => m.pickTokenId && m.slug && m.pickSide)
    .filter((m) => !autoPlacedIds.value.has(placeKey(m)))
    .map((m) => ({
      slug: m.slug,
      side: m.pickSide,
      tokenId: m.pickTokenId,
      amountUsd: amount,
      id: m.id,
      label: `${m.home} vs ${m.away}`,
      pickName: m.pickName,
    }))
}

async function placeOrders(orders, { auto = false } = {}) {
  if (!orders.length) return
  if (!allowBatchTrade.value) {
    batchError.value = '无法下单：请确认会员与钱包'
    return
  }
  const amount = Math.round(Number(batchAmountUsd.value) * 100) / 100
  if (!(amount >= 1)) {
    batchError.value = '投注金额至少 $1'
    return
  }
  batchSubmitting.value = true
  batchError.value = ''
  batchNotice.value = ''
  try {
    const payload = {
      orders: orders.map((o) => ({
        slug: o.slug,
        side: o.side,
        tokenId: o.tokenId,
        amountUsd: amount,
      })),
    }
    const resp = await placeDota2TradeBatch(payload)
    const results = Array.isArray(resp?.results) ? resp.results : []
    let ok = 0
    let skip = 0
    let fail = 0
    const nextPlaced = new Set(autoPlacedIds.value)
    const nextOrders = [...placedOrders.value]
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i]
      const src = orders[i]
      const key = r.slug && r.side ? `${r.slug}:${r.side}` : (src ? placeKey(src) : '')
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
    batchNotice.value = `${auto ? '自动' : '手动'}下单：成功 ${ok} · 跳过 ${skip} · 失败 ${fail}`
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
  const orders = buildOrdersFromMatches(selected, Number(batchAmountUsd.value))
  if (!orders.length) {
    batchError.value = '请先勾选可下单场次'
    return
  }
  await placeOrders(orders, { auto: false })
}

async function runAutoBet() {
  if (!autoSimBetEnabled.value || !allowBatchTrade.value || autoBetRunning || batchSubmitting.value) return
  const hc = marketRows.value.filter((m) => m.passAutoBet || m.is_high_confidence)
  const orders = buildOrdersFromMatches(hc, Number(batchAmountUsd.value)).slice(0, 10)
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
      <div class="stats">
        <div class="stat"><b>{{ stats.collected }}</b><span>扫</span></div>
        <div class="stat stat-static active"><b>{{ stats.open }}</b><span>未开</span></div>
        <div class="stat"><b>{{ stats.edge }}</b><span>过线</span></div>
        <div class="stat"><b>{{ stats.hc }}</b><span>HC</span></div>
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
      :show-manual-trade-opts="false"
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
    <div v-else-if="!marketRows.length" class="empty" role="status">
      {{ emptyListHint }}
      <div v-if="bundleHint" class="hint">{{ bundleHint }}</div>
    </div>
    <template v-else>
      <div class="list">
        <article
          v-for="m in paginatedMatches"
          :key="m.id"
          class="row-card"
          :class="{ selected: isSelected(m), selectable: canSelectMatch(m) }"
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
              <span class="tour-title">差 {{ num(m.eloDiff) }}</span>
              <div class="badges">
                <span v-if="m.is_high_confidence" class="badge hc">HC</span>
                <span v-else-if="m.passList" class="badge edge">过线</span>
                <span v-if="m.url" class="badge poly">外</span>
                <span v-if="m.pickSide" class="badge pick">优</span>
              </div>
            </div>
            <div class="row-main">
              <div class="matchup is-stacked">
                <div class="matchup-line">
                  <span class="name" :class="{ pick: m.pickSide === 'a' }">
                    <span class="list-rank">{{ num(m.teamA?.rating) }}</span>
                    <span class="player-name">{{ m.home }}</span>
                    <span v-if="m.pickSide === 'a'" class="pick-tag">优</span>
                  </span>
                  <span class="side-nums">
                    <em>{{ sideProb(m, 'a') }}</em>
                    <em class="pm">{{ pmPrice(m, 'a') }}</em>
                  </span>
                </div>
                <span class="vs-row">VS</span>
                <div class="matchup-line">
                  <span class="name" :class="{ pick: m.pickSide === 'b' }">
                    <span class="list-rank">{{ num(m.teamB?.rating) }}</span>
                    <span class="player-name">{{ m.away }}</span>
                    <span v-if="m.pickSide === 'b'" class="pick-tag">优</span>
                  </span>
                  <span class="side-nums">
                    <em>{{ sideProb(m, 'b') }}</em>
                    <em class="pm">{{ pmPrice(m, 'b') }}</em>
                  </span>
                </div>
              </div>
              <div class="row-actions">
                <button type="button" class="act-btn" @click="openDetail(m)">详情</button>
                <button
                  type="button"
                  class="act-btn market"
                  :disabled="!m.url"
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
            <div class="modal-title">详情</div>
            <div class="modal-sub">{{ detailMatch.home }} vs {{ detailMatch.away }}</div>
            <div class="modal-meta">
              <span :class="{ today: isStartSameDay(detailMatch.startTimestamp) }">{{ fmtTime(detailMatch.startTimestamp) }}</span>
              · 未开
              <template v-if="detailMatch.is_high_confidence"> · 高置信度</template>
            </div>
            <div class="badges modal-badges">
              <span v-if="detailMatch.is_high_confidence" class="badge hc">HC</span>
              <span v-else-if="detailMatch.passList" class="badge edge">过线</span>
              <span v-if="detailMatch.url" class="badge poly">外</span>
              <span v-if="detailMatch.pickSide" class="badge pick">优</span>
            </div>
          </div>
          <div class="duel">
            <div class="duel-side" :class="{ pick: detailMatch.pickSide === 'a' }">
              <div class="duel-elo">Elo {{ num(detailMatch.teamA?.rating) }}</div>
              <div class="duel-name">{{ detailMatch.home }}</div>
              <div class="duel-prob">{{ sideProb(detailMatch, 'a') }}</div>
              <div class="duel-pm">PM {{ pmPrice(detailMatch, 'a') }}</div>
            </div>
            <div class="duel-mid">
              <div class="bar-wrap">
                <div class="bar" :style="{ width: `${Math.round(Number(detailMatch.pA || 0.5) * 100)}%` }" />
              </div>
              <div class="muted">Elo差 {{ num(detailMatch.eloDiff) }}</div>
              <div class="muted">风险分 {{ detailMatch.risk_points ?? '—' }}</div>
              <div v-if="detailMatch.pickName" class="pick-line">荐 {{ detailMatch.pickName }}</div>
            </div>
            <div class="duel-side" :class="{ pick: detailMatch.pickSide === 'b' }">
              <div class="duel-elo">Elo {{ num(detailMatch.teamB?.rating) }}</div>
              <div class="duel-name">{{ detailMatch.away }}</div>
              <div class="duel-prob">{{ sideProb(detailMatch, 'b') }}</div>
              <div class="duel-pm">PM {{ pmPrice(detailMatch, 'b') }}</div>
            </div>
          </div>
          <div class="modal-actions">
            <button
              type="button"
              class="act-btn market"
              :disabled="!detailMatch.url"
              @click="openMarket(detailMatch)"
            >外链</button>
            <button type="button" class="act-btn" @click="closeDetail">关闭</button>
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
}
.topbar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  overflow-x: auto;
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
.btn:disabled { opacity: 0.5; cursor: wait; }
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 3px;
  margin: 0 0 0 auto;
  min-width: 148px;
  flex: 1;
  max-width: 220px;
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
}
.stat b {
  color: var(--primary);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat span { color: var(--muted); font-size: 0.58rem; line-height: 1.2; }
.stat-static { cursor: default; }
.stat-static.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  box-shadow: 0 0 0 1px rgba(79, 70, 229, 0.25);
}
.stat-static.active span { color: #6366f1; font-weight: 600; }

.empty {
  text-align: center;
  color: var(--muted);
  padding: 16px 8px;
  font-size: 0.86rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
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
.badge.poly { background: #f5f3ff; color: #6d28d9; }
.badge.pick { background: var(--primary); color: #fff; }
.row-main {
  display: flex;
  align-items: center;
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
  gap: 10px;
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
  gap: 8px;
  flex-shrink: 0;
  font-style: normal;
}
.side-nums em {
  font-style: normal;
  font-variant-numeric: tabular-nums;
  font-size: 0.78rem;
  font-weight: 700;
  color: #334155;
  min-width: 3.2em;
  text-align: right;
}
.side-nums em.pm { color: #64748b; min-width: 2.4em; }
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
.act-btn:disabled { opacity: 0.4; cursor: not-allowed; }

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
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px;
}
.modal-sheet {
  width: min(520px, 100%);
  max-height: min(86vh, 720px);
  overflow: auto;
  background: #fff;
  border-radius: 16px 16px 12px 12px;
  padding: 14px 14px 18px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
}
.modal-title { font-size: 1rem; font-weight: 800; }
.modal-sub { margin-top: 2px; font-size: 0.9rem; font-weight: 700; color: #334155; }
.modal-meta { margin-top: 4px; font-size: 0.72rem; color: #94a3b8; }
.modal-meta .today { color: #dc2626; font-weight: 700; }
.modal-badges { margin-top: 8px; }
.duel {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 10px;
  margin-top: 16px;
  align-items: center;
}
.duel-side { text-align: center; }
.duel-side.pick .duel-name { color: var(--primary); }
.duel-elo { font-size: 0.68rem; color: #64748b; font-weight: 700; }
.duel-name { font-size: 0.95rem; font-weight: 800; margin: 4px 0; }
.duel-prob { font-size: 1.25rem; font-weight: 800; color: #0f172a; }
.duel-pm { font-size: 0.72rem; color: #64748b; margin-top: 2px; }
.duel-mid { text-align: center; min-width: 88px; }
.bar-wrap {
  height: 8px;
  background: #e2e8f0;
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 8px;
}
.bar { height: 100%; background: var(--success); }
.muted { font-size: 0.68rem; color: #94a3b8; }
.pick-line { margin-top: 6px; font-size: 0.75rem; font-weight: 800; color: var(--primary); }
.modal-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
