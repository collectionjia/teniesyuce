<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import * as api from '../api'
import { LIVE_TIER_OPTIONS } from '../utils/tennisLiveFilter'

const loading = ref(true)
const refreshing = ref(false)
const playersLoading = ref(false)
const error = ref('')
const notice = ref('')
const status = ref(null)
const playersData = ref(null)
const preview = ref(null)
const tier = ref('all')
const tourTab = ref('atp') // atp | wta

let pollTimer = null

const pollIntervalSec = computed(() => Number(status.value?.poll_interval_sec || 120))
const cache = computed(() => status.value?.cache || null)
const tierCounts = computed(() => status.value?.tier_counts || {})
const livePoll = computed(() => status.value?.live_poll || {})
const matches = computed(() => preview.value?.matches || [])

const tierOptions = LIVE_TIER_OPTIONS

const players = computed(() => {
  const list = tourTab.value === 'wta' ? playersData.value?.wta : playersData.value?.atp
  return Array.isArray(list) ? list : []
})

const livePlayerCount = computed(() => players.value.filter((p) => p.inLive).length)

function fmtTime(v) {
  if (!v) return '—'
  return String(v).replace('T', ' ').slice(0, 19)
}

async function loadStatus() {
  status.value = await api.fetchTennisLiveMonitorStatus()
}

async function loadPlayers(refresh = false) {
  playersLoading.value = true
  try {
    playersData.value = await api.fetchTennisLiveMonitorPlayers(refresh)
  } finally {
    playersLoading.value = false
  }
}

async function loadPreview() {
  preview.value = await api.fetchTennisLiveMonitorPreview(tier.value)
}

async function refreshAll({ silent = false } = {}) {
  if (!silent) {
    refreshing.value = true
    error.value = ''
  }
  try {
    await Promise.all([loadStatus(), loadPlayers(false), loadPreview()])
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function forceRefreshPlayers() {
  playersLoading.value = true
  error.value = ''
  try {
    playersData.value = await api.fetchTennisLiveMonitorPlayers(true)
    notice.value = `排名已更新 · ATP ${playersData.value?.atp?.length ?? 0} · WTA ${playersData.value?.wta?.length ?? 0}`
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '排名拉取失败'
  } finally {
    playersLoading.value = false
  }
}

async function forceRefresh() {
  refreshing.value = true
  error.value = ''
  notice.value = ''
  try {
    const resp = await api.refreshTennisLiveMonitorCache()
    notice.value = `盘中缓存已刷新 · ${resp.live ?? resp.events ?? 0} 场`
    await refreshAll({ silent: true })
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '刷新失败'
  } finally {
    refreshing.value = false
  }
}

onMounted(async () => {
  await refreshAll()
  pollTimer = setInterval(() => refreshAll({ silent: true }), 30000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="space-y-3">
    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">ATP · WTA 盘中监控</h2>
          <p class="text-xs text-slate-500 mt-1">
            Top100 运动员 · Sofascore 每 {{ pollIntervalSec }} 秒轮询 · 分档现差筛选
          </p>
        </div>
        <div class="flex gap-2 shrink-0">
          <button
            type="button"
            class="px-3 py-2 rounded-xl border border-slate-200 text-slate-700 text-sm font-medium disabled:opacity-60"
            :disabled="playersLoading"
            @click="forceRefreshPlayers"
          >{{ playersLoading ? '拉排名中…' : '拉取排名' }}</button>
          <button
            type="button"
            class="px-3 py-2 rounded-xl bg-primary-600 text-white text-sm font-medium disabled:opacity-60"
            :disabled="refreshing"
            @click="forceRefresh"
          >{{ refreshing ? '刷新中…' : '刷新盘中' }}</button>
        </div>
      </div>

      <div v-if="error" class="text-sm text-rose-600 bg-rose-50 rounded-xl px-3 py-2">{{ error }}</div>
      <div v-if="notice" class="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2">{{ notice }}</div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
        <div class="rounded-xl bg-slate-50 px-2 py-2">
          <div class="text-[11px] text-slate-400">Redis 盘中</div>
          <div class="text-lg font-semibold tabular-nums">{{ cache?.live ?? '—' }}</div>
        </div>
        <div class="rounded-xl bg-slate-50 px-2 py-2">
          <div class="text-[11px] text-slate-400">监控 live</div>
          <div class="text-lg font-semibold tabular-nums">{{ livePoll.live_count ?? '—' }}</div>
        </div>
        <div class="rounded-xl bg-violet-50 px-2 py-2">
          <div class="text-[11px] text-violet-500">Top100 盘中人</div>
          <div class="text-lg font-semibold tabular-nums text-violet-700">{{ livePlayerCount }}</div>
        </div>
        <div class="rounded-xl bg-slate-50 px-2 py-2">
          <div class="text-[11px] text-slate-400">最近更新</div>
          <div class="text-sm font-medium">{{ fmtTime(cache?.fetched_at || livePoll.fetched_at || playersData?.fetched_at) }}</div>
        </div>
      </div>
    </div>

    <!-- Top100 运动员列表 -->
    <div class="bg-white rounded-2xl p-4 shadow-sm">
      <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="font-semibold">Top100 运动员</div>
        <div class="flex gap-1">
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg text-xs font-medium"
            :class="tourTab === 'atp' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'"
            @click="tourTab = 'atp'"
          >ATP ({{ playersData?.atp?.length ?? 0 }})</button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg text-xs font-medium"
            :class="tourTab === 'wta' ? 'bg-pink-100 text-pink-800' : 'bg-slate-100 text-slate-600'"
            @click="tourTab = 'wta'"
          >WTA ({{ playersData?.wta?.length ?? 0 }})</button>
        </div>
      </div>

      <div class="text-[11px] text-slate-400 mb-2">
        更新 {{ fmtTime(playersData?.fetched_at) }}
        <span v-if="playersData?.source"> · {{ playersData.source }}</span>
      </div>

      <div v-if="loading && !playersData" class="text-sm text-slate-400 py-8 text-center">加载运动员…</div>
      <div v-else-if="playersLoading && !players.length" class="text-sm text-slate-400 py-8 text-center">正在拉取 Sofascore Top100…</div>
      <div v-else-if="!players.length" class="text-sm text-slate-400 py-8 text-center">暂无排名数据，点「拉取排名」</div>
      <div v-else class="player-table-wrap">
        <div class="player-head">
          <span>排名</span>
          <span>运动员</span>
          <span>积分</span>
          <span>盘中</span>
        </div>
        <div
          v-for="p in players"
          :key="p.id || p.name"
          class="player-row"
          :class="{ live: p.inLive }"
        >
          <span class="rank tabular-nums">#{{ p.rank ?? '—' }}</span>
          <span class="name-col min-w-0">
            <span class="name truncate">{{ p.name }}</span>
            <span class="sub truncate">{{ p.country || '—' }}</span>
          </span>
          <span class="pts tabular-nums">{{ p.points ?? '—' }}</span>
          <span class="live-col">
            <span v-if="p.inLive" class="live-badge">进行中</span>
            <span v-else class="text-slate-300">—</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 符合档位场次 -->
    <div class="bg-white rounded-2xl p-4 shadow-sm">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div class="font-semibold">符合档位场次 · {{ preview?.count ?? 0 }}</div>
        <button type="button" class="text-xs text-primary-700" :disabled="loading" @click="refreshAll()">刷新列表</button>
      </div>

      <div class="flex flex-wrap gap-2 mb-3">
        <span
          v-for="opt in tierOptions"
          :key="opt.value"
          class="px-2.5 py-1 rounded-full text-xs border cursor-pointer"
          :class="tier === opt.value ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600'"
          @click="tier = opt.value; loadPreview()"
        >
          {{ opt.label }}
          <span class="opacity-70">({{ tierCounts[opt.value] ?? 0 }})</span>
        </span>
      </div>

      <div v-if="loading && !preview" class="text-sm text-slate-400 py-6 text-center">加载中…</div>
      <div v-else-if="!matches.length" class="text-sm text-slate-400 py-6 text-center">当前档位无进行中场次</div>
      <div v-else class="space-y-2">
        <div
          v-for="m in matches"
          :key="m.id"
          class="border border-slate-100 rounded-xl px-3 py-2.5 text-sm"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="font-medium truncate">{{ m.home }} vs {{ m.away }}</div>
              <div class="text-[11px] text-slate-400 mt-0.5">
                {{ m.tour || '—' }} · {{ m.status || 'live' }}
                <template v-if="m.scoreText"> · {{ m.scoreText }}</template>
              </div>
            </div>
            <span class="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">{{ m.tier }}</span>
          </div>
          <div class="text-[11px] text-slate-500 mt-1 tabular-nums">
            现排 {{ m.homeR ?? '—' }} vs {{ m.awayR ?? '—' }} · 现差 {{ m.gap ?? '—' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-table-wrap {
  max-height: min(52vh, 520px);
  overflow: auto;
  border: 1px solid #f1f5f9;
  border-radius: 12px;
}
.player-head,
.player-row {
  display: grid;
  grid-template-columns: 52px 1fr 64px 56px;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  font-size: 0.82rem;
}
.player-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #f8fafc;
  color: #94a3b8;
  font-size: 0.7rem;
  font-weight: 600;
  border-bottom: 1px solid #e2e8f0;
}
.player-row {
  border-bottom: 1px solid #f1f5f9;
}
.player-row:last-child { border-bottom: 0; }
.player-row.live { background: #faf5ff; }
.rank { font-weight: 700; color: #64748b; }
.name { display: block; font-weight: 600; color: #0f172a; }
.sub { display: block; font-size: 0.68rem; color: #94a3b8; margin-top: 1px; }
.pts { text-align: right; color: #475569; font-size: 0.75rem; }
.live-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 999px;
  background: #7c3aed;
  color: #fff;
  font-size: 0.65rem;
  font-weight: 600;
}
</style>
