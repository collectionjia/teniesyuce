<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import * as api from '../api'

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const live = ref(null)
const scoreListOpen = ref(false)
const scoreListLoading = ref(false)
const scoreList = ref(null)
let pollTimer = null

const form = reactive({
  score_enabled: true,
  score_interval_sec: 30,
  odds_enabled: true,
  odds_interval_sec: 1,
})

function applyFromCfg(cfg) {
  const bg = cfg?.collect?.background || {}
  form.score_enabled = bg.score_enabled !== false
  form.score_interval_sec = Number(bg.score_interval_sec) || 30
  form.odds_enabled = bg.odds_enabled !== false
  form.odds_interval_sec = Number(bg.odds_interval_sec) || 1
}

function fmtLast(last) {
  if (!last?.at) return '尚无记录'
  const st = last.ok === false ? '失败' : '成功'
  return `${last.at.replace('T', ' ').slice(0, 19)} · ${st} · ${last.message || '-'}`
}

async function loadCfg() {
  const cfg = await api.fetchTennisEngines({ force: true })
  applyFromCfg(cfg)
}

async function loadLive() {
  try {
    live.value = await api.fetchCollectBackgroundStatus()
  } catch (e) {
    if (!live.value) live.value = { error: e?.response?.data?.error || e?.message }
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    await Promise.all([loadCfg(), loadLive()])
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function refresh() {
  void load()
}

async function save() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const scoreSec = Math.min(600, Math.max(5, Math.round(Number(form.score_interval_sec) || 30)))
    const oddsSec = Math.min(60, Math.max(1, Math.round(Number(form.odds_interval_sec) || 1)))
    const cfg = await api.updateTennisEngines({
      collect: {
        background: {
          score_enabled: !!form.score_enabled,
          score_interval_sec: scoreSec,
          odds_enabled: !!form.odds_enabled,
          odds_interval_sec: oddsSec,
        },
      },
    })
    applyFromCfg(cfg)
    notice.value = '保存成功，后台循环已按新间隔重启'
    await loadLive()
  } catch (e) {
    error.value = `保存失败：${e?.response?.data?.error || e?.message || '请重试'}`
  } finally {
    saving.value = false
  }
}

async function clearLogs(kind) {
  try {
    await api.clearCollectBackgroundLogs(kind)
    await loadLive()
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '清空日志失败'
  }
}

async function loadScoreMatches() {
  scoreListLoading.value = true
  try {
    scoreList.value = await api.fetchScoreTrackedMatches()
  } catch (e) {
    scoreList.value = { ok: false, error: e?.response?.data?.error || e?.message || '加载失败', matches: [] }
  } finally {
    scoreListLoading.value = false
  }
}

async function toggleScoreList() {
  scoreListOpen.value = !scoreListOpen.value
  if (scoreListOpen.value) await loadScoreMatches()
}

onMounted(() => {
  void load()
  pollTimer = setInterval(() => { void loadLive() }, 5000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="space-y-3">
    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-4">
      <div>
        <div class="font-semibold">采集频率</div>
        <div class="text-xs text-slate-400 mt-0.5 leading-relaxed">
          控制 server 后台循环：Sofascore 盘中比分、Polymarket 赔率（含 Dota2/NFL）。保存后立即生效。
        </div>
      </div>

      <p v-if="loading" class="text-sm text-slate-400">加载中…</p>
      <p v-else-if="error" class="text-sm text-rose-600">{{ error }}</p>
      <p v-if="notice" class="text-sm text-emerald-600">{{ notice }}</p>

      <template v-if="!loading">
        <!-- 比分 -->
        <div class="rounded-xl border border-slate-200 p-3 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <div class="font-medium text-sm">Sofascore 比分</div>
            </div>
            <label class="collect-toggle">
              <input v-model="form.score_enabled" type="checkbox" class="sr-only" />
              <span class="toggle-track" :class="{ on: form.score_enabled }" />
              <span class="toggle-state" :class="{ off: !form.score_enabled }">
                {{ form.score_enabled ? '已开启' : '已关闭' }}
              </span>
            </label>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <div class="text-xs text-slate-400 mb-1">间隔（秒，5–600）</div>
              <input
                v-model.number="form.score_interval_sec"
                type="number"
                min="5"
                max="600"
                step="1"
                :disabled="!form.score_enabled"
                class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 disabled:opacity-50"
              />
            </div>
            <div class="text-xs text-slate-500 flex flex-col justify-center gap-0.5">
              <span>运行：{{ live?.score?.running ? '是' : '否' }} · 忙：{{ live?.score?.busy ? '是' : '否' }}</span>
              <span>最近：{{ fmtLast(live?.score?.last) }}</span>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="btn-secondary"
              :disabled="scoreListLoading"
              @click="toggleScoreList"
            >
              {{ scoreListLoading ? '加载中…' : (scoreListOpen ? '收起赛事列表' : '赛事列表') }}
            </button>
            <span v-if="scoreList?.count != null" class="text-xs text-slate-500">
              进行中 {{ scoreList.count }} 场
              <template v-if="scoreList.skipped_not_started"> · 跳过未开赛 {{ scoreList.skipped_not_started }}</template>
            </span>
          </div>
          <div v-if="scoreListOpen" class="match-list-wrap">
            <p v-if="scoreListLoading" class="text-xs text-slate-400">加载赛事…</p>
            <p v-else-if="scoreList?.error" class="text-xs text-rose-600">{{ scoreList.error }}</p>
            <p v-else-if="scoreList?.message" class="text-xs text-slate-500">{{ scoreList.message }}</p>
            <p v-else-if="!scoreList?.matches?.length" class="text-xs text-slate-400">
              暂无进行中场次（未开赛已跳过{{ scoreList.skipped_not_started ? ` ${scoreList.skipped_not_started} 场` : '' }}）
            </p>
            <table v-else class="match-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>对阵</th>
                  <th>赛事</th>
                  <th>状态</th>
                  <th>比分</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in scoreList.matches" :key="m.id">
                  <td class="mono">{{ m.id }}</td>
                  <td>{{ m.label || `${m.home} vs ${m.away}` }}</td>
                  <td class="muted">{{ m.tournament || '—' }}</td>
                  <td>{{ m.phaseLabel || m.status || m.statusType || '—' }}</td>
                  <td>{{ m.scoreText || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-slate-400">运行日志</span>
              <button type="button" class="text-xs text-slate-500 hover:text-slate-700" @click="clearLogs('score')">清空</button>
            </div>
            <pre class="log-box">{{ (live?.score?.logs || []).join('\n') || '（暂无）' }}</pre>
          </div>
        </div>

        <!-- 赔率 -->
        <div class="rounded-xl border border-slate-200 p-3 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="font-medium text-sm">Polymarket 赔率</div>
            <label class="collect-toggle">
              <input v-model="form.odds_enabled" type="checkbox" class="sr-only" />
              <span class="toggle-track" :class="{ on: form.odds_enabled }" />
              <span class="toggle-state" :class="{ off: !form.odds_enabled }">
                {{ form.odds_enabled ? '已开启' : '已关闭' }}
              </span>
            </label>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <div class="text-xs text-slate-400 mb-1">间隔（秒，1–60）</div>
              <input
                v-model.number="form.odds_interval_sec"
                type="number"
                min="1"
                max="60"
                step="1"
                :disabled="!form.odds_enabled"
                class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 disabled:opacity-50"
              />
            </div>
            <div class="text-xs text-slate-500 flex flex-col justify-center gap-0.5">
              <span>运行：{{ live?.odds?.running ? '是' : '否' }} · 忙：{{ live?.odds?.busy ? '是' : '否' }}</span>
              <span>最近：{{ fmtLast(live?.odds?.last) }}</span>
            </div>
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-slate-400">运行日志</span>
              <button type="button" class="text-xs text-slate-500 hover:text-slate-700" @click="clearLogs('odds')">清空</button>
            </div>
            <pre class="log-box">{{ (live?.odds?.logs || []).join('\n') || '（暂无）' }}</pre>
          </div>
        </div>

        <div class="flex gap-2">
          <button
            type="button"
            :disabled="saving"
            class="flex-1 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-medium disabled:opacity-60"
            @click="save"
          >
            {{ saving ? '保存中…' : '保存配置' }}
          </button>
          <button
            type="button"
            :disabled="loading || saving"
            class="px-4 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-600 disabled:opacity-60"
            @click="refresh"
          >
            刷新
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.collect-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #fff;
  font-size: 0.82rem;
  color: #475569;
  cursor: pointer;
}
.toggle-track {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: #cbd5e1;
  position: relative;
  transition: background 0.15s;
}
.toggle-track.on {
  background: #10b981;
}
.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.toggle-track.on::after {
  transform: translateX(16px);
}
.toggle-state.off {
  color: #94a3b8;
}
.log-box {
  max-height: 160px;
  overflow: auto;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.45;
  color: #334155;
  white-space: pre-wrap;
  word-break: break-word;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
.btn-secondary {
  padding: 6px 12px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #fff;
  font-size: 12px;
  color: #475569;
}
.btn-secondary:hover:not(:disabled) {
  border-color: #94a3b8;
  color: #1e293b;
}
.btn-secondary:disabled {
  opacity: 0.6;
}
.match-list-wrap {
  max-height: 280px;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
  padding: 8px;
}
.match-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.match-table th,
.match-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid #e2e8f0;
  vertical-align: top;
}
.match-table th {
  color: #64748b;
  font-weight: 600;
  position: sticky;
  top: 0;
  background: #f1f5f9;
}
.match-table .mono {
  font-family: ui-monospace, monospace;
  color: #64748b;
}
.match-table .muted {
  color: #64748b;
  max-width: 140px;
}
</style>
