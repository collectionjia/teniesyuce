<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as api from '../api'

const emit = defineEmits(['open-scheduler', 'open-settings'])

const loading = ref(false)
const busy = ref({})
const overview = ref(null)
const collectDetail = ref(null)
const matched = ref({ prematch: null, inplay: null })
const openOrders = ref(null)
const stopDetail = ref(null)
const logLines = ref([])
const err = ref('')
const autoRefresh = ref(true)
let refreshTimer = null

const SERVICE_META = [
  { id: 'collect', label: '采集服务', port: 9101, color: 'from-emerald-500 to-lime-500', settingsView: 'tennis-collect', settingsLabel: '采集引擎' },
  { id: 'rules', label: '规则服务', port: 9102, color: 'from-amber-500 to-yellow-500', settingsView: 'tennis-condition', settingsLabel: '条件引擎' },
  { id: 'betting', label: '投注服务', port: 9103, color: 'from-violet-500 to-fuchsia-500', settingsView: 'tennis-betting', settingsLabel: '投注引擎' },
  { id: 'stopLoss', label: '止损服务', port: 9104, color: 'from-rose-500 to-orange-500', settingsView: 'tennis-stop', settingsLabel: '止损引擎' },
  { id: 'scheduler', label: '调度服务', port: 9105, color: 'from-sky-500 to-indigo-500', settingsView: 'scheduler-center', settingsLabel: '调度中心' },
]

function openSettings(card) {
  if (card?.settingsView) emit('open-settings', card.settingsView)
}

const cards = computed(() => {
  const sv = overview.value?.services || {}
  return SERVICE_META.map((m) => ({
    ...m,
    health: sv[m.id] || { ok: false, error: '未加载' },
  }))
})

function pushLog(line) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logLines.value = [`[${ts}] ${line}`, ...logLines.value].slice(0, 40)
}

function fmtJson(v) {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function healthLabel(h) {
  if (h?.ok === false) return h.error || '离线'
  if (h?.service === 'scheduler') {
    return h.running ? `运行中 · ${h.jobCount ?? '-'} 任务` : '就绪'
  }
  if (h?.running?.full || h?.running?.partial) return '执行中'
  return h?.phase ? `正常 · ${h.phase}` : '正常'
}

function healthOk(h) {
  return h?.ok !== false
}

async function refreshOverview() {
  loading.value = true
  err.value = ''
  try {
    overview.value = await api.fetchEngineServicesOverview()
    if (overview.value?.fallback) {
      err.value = 'server 未加载 /overview，已降级；请重启：cd server && npm run dev'
    }
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function refreshDetails() {
  try {
    const [cs, pm, ip, oo, sl] = await Promise.allSettled([
      api.fetchCollectServiceStatus(),
      api.fetchRulesMatched({ bucket: 'prematch' }),
      api.fetchRulesMatched({ bucket: 'inplay' }),
      api.fetchBettingOpenOrders(),
      api.fetchStopLossStatus(),
    ])
    if (cs.status === 'fulfilled') collectDetail.value = cs.value
    if (pm.status === 'fulfilled') matched.value.prematch = pm.value
    if (ip.status === 'fulfilled') matched.value.inplay = ip.value
    if (oo.status === 'fulfilled') openOrders.value = oo.value
    if (sl.status === 'fulfilled') stopDetail.value = sl.value
  } catch {
    /* 详情失败不阻断总览 */
  }
}

async function refreshAll() {
  await refreshOverview()
  await refreshDetails()
}

async function runAction(key, label, fn) {
  busy.value = { ...busy.value, [key]: true }
  err.value = ''
  try {
    const r = await fn()
    pushLog(`${label}: ${r.skipped ? r.message || 'skipped' : r.message || 'ok'}`)
    if (r.metrics) pushLog(fmtJson(r.metrics))
    await refreshAll()
    return r
  } catch (e) {
    const msg = e?.response?.data?.error || e.message || '失败'
    pushLog(`${label}: ${msg}`)
    err.value = msg
    throw e
  } finally {
    busy.value = { ...busy.value, [key]: false }
  }
}

onMounted(() => {
  refreshAll()
  refreshTimer = setInterval(() => {
    if (autoRefresh.value) refreshAll()
  }, 15000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="space-y-3">
    <div class="bg-white rounded-2xl p-4 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="font-semibold">五引擎服务</div>
          <div class="text-xs text-slate-400 mt-0.5">健康检查 · 手动触发 · 各卡片「设置」→ 引擎类配置页</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-xs text-slate-500 flex items-center gap-1.5">
            <input v-model="autoRefresh" type="checkbox" class="rounded">
            15s 自动刷新
          </label>
          <button
            type="button"
            class="text-xs font-medium px-3 py-1.5 rounded-lg bg-primary-600 text-white disabled:opacity-50"
            :disabled="loading"
            @click="refreshAll"
          >{{ loading ? '刷新中…' : '刷新' }}</button>
          <button
            type="button"
            class="text-xs font-medium px-3 py-1.5 rounded-lg ring-1 ring-slate-200 text-slate-600"
            @click="emit('open-scheduler')"
          >调度任务</button>
        </div>
      </div>
      <p v-if="err" class="text-xs text-red-600 mt-2">{{ err }}</p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      <div
        v-for="card in cards"
        :key="card.id"
        class="bg-white rounded-2xl p-4 shadow-sm ring-1 ring-slate-100"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <div :class="['h-9 w-9 rounded-xl shrink-0 bg-gradient-to-br', card.color]" />
            <div class="min-w-0">
              <div class="font-medium text-sm truncate">{{ card.label }}</div>
              <div class="text-[11px] text-slate-400">:{{ card.port }}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              class="settings-btn"
              :title="`打开${card.settingsLabel}配置`"
              @click="openSettings(card)"
            >设置</button>
            <span
              class="text-[10px] px-2 py-0.5 rounded-full"
              :class="healthOk(card.health) ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'"
            >{{ healthOk(card.health) ? '在线' : '异常' }}</span>
          </div>
        </div>
        <p class="text-xs text-slate-500 mt-2 leading-relaxed">{{ healthLabel(card.health) }}</p>

        <!-- collect -->
        <div v-if="card.id === 'collect'" class="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="action-btn"
            :disabled="busy.collectTop100"
            @click="runAction('collectTop100', 'Top100', () => api.runCollectFull({ top100: true }))"
          >Top100</button>
        </div>
        <p v-if="card.id === 'collect' && collectDetail" class="detail-line">
          运行 full={{ collectDetail.running?.full ? '是' : '否' }}
          partial={{ collectDetail.running?.partial ? '是' : '否' }}
        </p>

        <!-- rules -->
        <div v-if="card.id === 'rules'" class="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="action-btn"
            :disabled="busy.rulesPm"
            @click="runAction('rulesPm', '规则·盘前', () => api.runRulesEvaluate({ bucket: 'prematch' }))"
          >盘前</button>
          <button
            type="button"
            class="action-btn"
            :disabled="busy.rulesIp"
            @click="runAction('rulesIp', '规则·盘中', () => api.runRulesEvaluate({ bucket: 'inplay' }))"
          >盘中</button>
        </div>
        <p v-if="card.id === 'rules'" class="detail-line">
          matched 盘前 {{ matched.prematch?.count ?? '—' }} · 盘中 {{ matched.inplay?.count ?? '—' }}
        </p>

        <!-- betting -->
        <div v-if="card.id === 'betting'" class="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="action-btn"
            :disabled="busy.betPm"
            @click="runAction('betPm', '投注·盘前', () => api.runBettingScan({ bucket: 'prematch' }))"
          >盘前 scan</button>
          <button
            type="button"
            class="action-btn"
            :disabled="busy.betIp"
            @click="runAction('betIp', '投注·盘中', () => api.runBettingScan({ bucket: 'inplay' }))"
          >盘中 scan</button>
        </div>
        <p v-if="card.id === 'betting' && openOrders" class="detail-line">
          open 持仓 {{ openOrders.count ?? openOrders.orders?.length ?? '—' }}
        </p>

        <!-- stop-loss -->
        <div v-if="card.id === 'stopLoss'" class="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="action-btn"
            :disabled="busy.stopScan"
            @click="runAction('stopScan', '止损 scan', () => api.runStopLossScan())"
          >scan</button>
        </div>
        <p v-if="card.id === 'stopLoss' && stopDetail" class="detail-line">
          inplay open {{ stopDetail.openOrders ?? '—' }} · 事件 {{ stopDetail.inplayEvents ?? '—' }}
        </p>

        <!-- scheduler -->
        <div v-if="card.id === 'scheduler'" class="mt-3">
          <button
            type="button"
            class="action-btn w-full"
            @click="emit('open-scheduler')"
          >打开调度中心</button>
        </div>
      </div>
    </div>

    <div class="bg-white rounded-2xl p-4 shadow-sm">
      <div class="text-sm font-medium mb-2">操作日志</div>
      <pre v-if="logLines.length" class="log-box">{{ logLines.join('\n') }}</pre>
      <p v-else class="text-xs text-slate-400">点击上方按钮后在此显示结果</p>
    </div>
  </div>
</template>

<style scoped>
.action-btn {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 8px;
  background: #f1f5f9;
  color: #334155;
}
.action-btn:disabled {
  opacity: 0.5;
}
.action-btn:not(:disabled):hover {
  background: #e2e8f0;
}
.settings-btn {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #475569;
}
.settings-btn:hover {
  background: #f8fafc;
  border-color: #94a3b8;
}
.detail-line {
  margin: 8px 0 0;
  font-size: 11px;
  color: #64748b;
}
.log-box {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  color: #334155;
  background: #f8fafc;
  border-radius: 10px;
  padding: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
