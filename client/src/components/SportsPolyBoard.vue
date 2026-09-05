<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  apiBase: { type: String, required: true },
  sportLabel: { type: String, default: '' },
  isMember: { type: Boolean, default: false },
})

const PAGE_SIZE = 8
const data = ref(null)
const loading = ref(true)
const error = ref('')
const q = ref('')
const currentPage = ref(1)
let timer = null
let searchTimer = null

const member = computed(() => !!props.isMember || data.value?.member === true)
const events = computed(() => data.value?.events || [])
const totalPages = computed(() => Math.max(1, Math.ceil(events.value.length / PAGE_SIZE)))
const pageItems = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return events.value.slice(start, start + PAGE_SIZE)
})
const updatedAt = computed(() => data.value?.updatedAt || '')
const sport = computed(() => data.value?.sport || props.sportLabel || '')

watch(() => props.isMember, () => load())
watch(totalPages, (p) => {
  if (currentPage.value > p) currentPage.value = p
})

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function sideLabel(ev, idx) {
  const outs = ev?.outcomes || []
  return outs[idx] || (idx === 0 ? 'A' : 'B')
}

function sideCents(ev, idx) {
  if (!member.value) return null
  const c = ev?.cents
  if (Array.isArray(c) && c[idx] != null) return c[idx]
  const p = ev?.prices
  if (Array.isArray(p) && p[idx] != null) return Math.round(Number(p[idx]) * 100)
  return null
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const token = localStorage.getItem('token') || ''
    const qs = q.value.trim() ? `?q=${encodeURIComponent(q.value.trim())}` : ''
    const res = await fetch(`${props.apiBase}/events${qs}`, {
      headers: {
        Accept: 'application/json',
        Authorization: token ? `Bearer ${token}` : '',
      },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    data.value = body
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    currentPage.value = 1
    load()
  }, 300)
}

function openPoly(ev) {
  if (!member.value || !ev?.url) return
  window.open(ev.url, '_blank', 'noopener,noreferrer')
}

onMounted(() => {
  load()
  timer = setInterval(load, 60_000)
})
onUnmounted(() => {
  clearInterval(timer)
  clearTimeout(searchTimer)
})
</script>

<template>
  <div class="poly-board">
    <div class="toolbar">
      <div class="meta">
        <div class="title">{{ sport }} · Polymarket</div>
        <div class="sub">
          {{ events.length }} 场
          <template v-if="updatedAt"> · 更新 {{ fmtTime(updatedAt) }}</template>
          <template v-if="!member"> · 预览模式</template>
        </div>
      </div>
      <input
        v-model="q"
        type="search"
        class="search"
        placeholder="搜索对阵…"
        @input="onSearchInput"
      />
    </div>

    <div v-if="loading && !data" class="empty">加载中…</div>
    <div v-else-if="error" class="empty err">{{ error }}</div>
    <div v-else-if="!pageItems.length" class="empty">暂无盘口</div>
    <div v-else class="list">
      <button
        v-for="ev in pageItems"
        :key="ev.slug || ev.id"
        type="button"
        class="row"
        :class="{ locked: !member }"
        @click="openPoly(ev)"
      >
        <div class="row-main">
          <div class="ev-title">{{ ev.title || '未命名赛事' }}</div>
          <div class="ev-time">{{ fmtTime(ev.endDate || ev.startDate) }}</div>
        </div>
        <div class="sides">
          <div class="side">
            <span class="name">{{ sideLabel(ev, 0) }}</span>
            <span class="cent">{{ sideCents(ev, 0) == null ? '—' : sideCents(ev, 0) + '¢' }}</span>
          </div>
          <div class="side">
            <span class="name">{{ sideLabel(ev, 1) }}</span>
            <span class="cent">{{ sideCents(ev, 1) == null ? '—' : sideCents(ev, 1) + '¢' }}</span>
          </div>
        </div>
        <span v-if="member && ev.url" class="ext">外</span>
      </button>
    </div>

    <div v-if="totalPages > 1" class="pager">
      <button type="button" :disabled="currentPage <= 1" @click="currentPage--">上一页</button>
      <span>{{ currentPage }} / {{ totalPages }}</span>
      <button type="button" :disabled="currentPage >= totalPages" @click="currentPage++">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.poly-board {
  padding: 0.5rem;
  color: #0f172a;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.meta .title {
  font-weight: 700;
  font-size: 0.9rem;
}
.meta .sub {
  font-size: 0.7rem;
  color: #64748b;
  margin-top: 0.1rem;
}
.search {
  flex: 1;
  min-width: 8rem;
  max-width: 16rem;
  border: 1px solid #e2e8f0;
  border-radius: 0.75rem;
  padding: 0.4rem 0.7rem;
  font-size: 0.8rem;
  outline: none;
}
.search:focus {
  border-color: #93c5fd;
}
.empty {
  text-align: center;
  color: #94a3b8;
  padding: 2rem 0.5rem;
  font-size: 0.85rem;
}
.empty.err {
  color: #e11d48;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.5rem;
  align-items: center;
  text-align: left;
  width: 100%;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 0.85rem;
  padding: 0.65rem 0.75rem;
  cursor: pointer;
}
.row.locked {
  cursor: default;
}
.row:hover:not(.locked) {
  border-color: #93c5fd;
  background: #f8fbff;
}
.ev-title {
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1.25;
}
.ev-time {
  font-size: 0.68rem;
  color: #94a3b8;
  margin-top: 0.15rem;
}
.sides {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 7.5rem;
}
.side {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.72rem;
}
.side .name {
  color: #475569;
  max-width: 5.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side .cent {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #0f172a;
}
.ext {
  font-size: 0.65rem;
  font-weight: 700;
  color: #2563eb;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  border-radius: 999px;
  padding: 0.15rem 0.4rem;
}
.pager {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.6rem;
  font-size: 0.75rem;
  color: #64748b;
}
.pager button {
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 0.6rem;
  padding: 0.3rem 0.7rem;
}
.pager button:disabled {
  opacity: 0.4;
}
</style>
