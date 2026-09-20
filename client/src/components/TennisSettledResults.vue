<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { fetchTennisSettledToday } from '../api'
import { sofaTennisMatchUrl } from '../utils/sofaMatchUrl'

defineProps({
  standalone: { type: Boolean, default: false },
})

const loading = ref(false)
const error = ref('')
const matches = ref([])
const availableDates = ref([])
const settledDate = ref('all')
const message = ref('')

function fmtTime(isoOrTs) {
  if (!isoOrTs) return '—'
  const d = typeof isoOrTs === 'number'
    ? new Date(isoOrTs > 1e12 ? isoOrTs : isoOrTs * 1000)
    : new Date(isoOrTs)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function winnerLabel(m) {
  if (m.winner === 'home') return m.home || m.winnerName || '主'
  if (m.winner === 'away') return m.away || m.winnerName || '客'
  return m.winnerName || '—'
}

function pickHitText(m) {
  if (m.pickHit === 1) return '荐中'
  if (m.pickHit === 0) return '荐未中'
  return '无推荐'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const params = {}
    if (settledDate.value && settledDate.value !== 'all') params.date = settledDate.value
    const bundle = await fetchTennisSettledToday(params)
    matches.value = bundle?.live?.matches || []
    availableDates.value = Array.isArray(bundle?.availableDates) ? bundle.availableDates : []
    message.value = bundle?.message || ''
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '加载失败'
    matches.value = []
  } finally {
    loading.value = false
  }
}

watch(settledDate, () => {
  void load()
})

onMounted(() => {
  void load()
})

const titleDate = computed(() => (
  settledDate.value === 'all' ? '全部日期' : settledDate.value
))
</script>

<template>
  <div class="page" :class="{ standalone }">
    <header class="head">
      <div>
        <h1>完赛网球</h1>
        <p class="sub">来自 MySQL · {{ titleDate }} · {{ matches.length }} 场</p>
      </div>
      <button type="button" class="btn" :disabled="loading" @click="load">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </header>

    <div class="filters">
      <button
        type="button"
        class="chip"
        :class="{ on: settledDate === 'all' }"
        @click="settledDate = 'all'"
      >全部</button>
      <button
        v-for="d in availableDates.slice(0, 10)"
        :key="d.date"
        type="button"
        class="chip"
        :class="{ on: settledDate === d.date }"
        @click="settledDate = d.date"
      >{{ String(d.date).slice(5) }}·{{ d.count }}</button>
      <input
        class="date"
        type="date"
        :value="settledDate !== 'all' ? settledDate : ''"
        @change="settledDate = $event.target.value || 'all'"
      />
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <p v-else-if="!loading && !matches.length" class="empty">暂无完赛记录</p>
    <p v-else-if="message && !loading" class="hint">{{ message }}</p>

    <div class="list">
      <article v-for="m in matches" :key="m.id" class="card">
        <div class="row top">
          <span class="time">{{ fmtTime(m.settledAt || m.startTimestamp) }}</span>
          <span class="badge" :class="m.pickHit === 1 ? 'ok' : (m.pickHit === 0 ? 'miss' : '')">
            {{ pickHitText(m) }}
          </span>
        </div>
        <div class="names">
          <span :class="{ win: m.winner === 'home' }">{{ m.home }}</span>
          <span class="vs">vs</span>
          <span :class="{ win: m.winner === 'away' }">{{ m.away }}</span>
        </div>
        <div class="row meta">
          <span>比分 {{ m.scoreText || '—' }}</span>
          <span>胜方 {{ winnerLabel(m) }}</span>
        </div>
        <div class="row meta">
          <span v-if="m.pickName">推荐 {{ m.pickName }}</span>
          <span v-else>无推荐</span>
          <a
            v-if="sofaTennisMatchUrl(m) !== '#'"
            class="link"
            :href="sofaTennisMatchUrl(m)"
            target="_blank"
            rel="noopener noreferrer"
          >Sofascore</a>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100%;
  background: #f8fafc;
  color: #0f172a;
  padding: 16px;
}
.page.standalone {
  min-height: 100vh;
  max-width: 720px;
  margin: 0 auto;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
h1 {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 800;
}
.sub {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 0.85rem;
}
.btn {
  border: 0;
  background: #0f172a;
  color: #fff;
  border-radius: 10px;
  padding: 8px 14px;
  font-weight: 700;
  cursor: pointer;
}
.btn:disabled { opacity: 0.6; cursor: wait; }
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  align-items: center;
}
.chip {
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #64748b;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}
.chip.on {
  color: #4f46e5;
  background: #eef2ff;
  border-color: #c7d2fe;
  font-weight: 700;
}
.date {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 0.82rem;
}
.err { color: #dc2626; font-size: 0.9rem; }
.empty, .hint { color: #64748b; font-size: 0.9rem; margin: 8px 0 12px; }
.list { display: flex; flex-direction: column; gap: 10px; }
.card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px 14px;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.top { margin-bottom: 6px; }
.time { color: #64748b; font-size: 0.78rem; font-weight: 600; }
.badge {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
}
.badge.ok { background: #ecfdf5; color: #047857; }
.badge.miss { background: #fef2f2; color: #b91c1c; }
.names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-weight: 700;
  font-size: 1rem;
  margin-bottom: 6px;
}
.vs { color: #94a3b8; font-size: 0.8rem; font-weight: 600; }
.win { color: #2563eb; }
.meta {
  color: #64748b;
  font-size: 0.8rem;
  margin-top: 4px;
}
.link {
  color: #047857;
  font-weight: 700;
  text-decoration: none;
}
</style>
