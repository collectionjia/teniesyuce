<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as api from '../api'

const loading = ref(false)
const status = ref(null)
const jobs = ref([])
const jobTypes = ref([])
const nameOptions = ref({ collect: [], condition: [], betting: [], stop: [] })
const selectedJobId = ref('')
const runs = ref([])
const msg = ref('')
const err = ref('')
const logBox = ref(null)
const autoRefreshLogs = ref(true)
let logTimer = null

const createOpen = ref(false)
const creating = ref(false)

function defaultForm() {
  return {
    nameKey: '',
    jobType: 'collect.full',
    scheduleMode: 'interval',
    intervalSec: 60,
    dailyTime: '09:00',
    enabled: true,
  }
}

const form = ref(defaultForm())

const HIDDEN_JOB_TYPES = new Set(['collect.inplay_tick'])

const jobTypeOptions = computed(() => {
  const list = jobTypes.value.length
    ? jobTypes.value
    : [
      { jobType: 'collect.full', label: '采集引擎 · 全量', category: 'collect' },
      { jobType: 'collect.top100', label: '采集引擎 · Top100 collect.py', category: 'collect' },
      { jobType: 'condition.query', label: '条件引擎 · 查询筛选', category: 'condition' },
      { jobType: 'bet.scan', label: '投注引擎 · 扫描下单', category: 'betting' },
      { jobType: 'bet.stop_loss', label: '止损引擎 · 持仓止损扫描', category: 'stop' },
    ]
  return list.filter((t) => !HIDDEN_JOB_TYPES.has(t.jobType))
})

const CATEGORY_LABELS = {
  collect: '采集引擎',
  condition: '条件引擎',
  betting: '投注引擎',
  stop: '止损引擎',
}

const visibleJobs = computed(() => jobs.value.filter((j) => !HIDDEN_JOB_TYPES.has(j.jobType)))

const jobTypeGroups = computed(() => {
  const order = ['collect', 'condition', 'betting', 'stop']
  const map = { collect: [], condition: [], betting: [], stop: [] }
  for (const t of jobTypeOptions.value) {
    const cat = t.category || categoryOfJobType(t.jobType)
    if (!map[cat]) map[cat] = []
    map[cat].push(t)
  }
  return order
    .filter((cat) => map[cat]?.length)
    .map((cat) => ({ category: cat, label: CATEGORY_LABELS[cat] || cat, items: map[cat] }))
})

function categoryOfJobType(jobType) {
  const t = jobTypeOptions.value.find((x) => x.jobType === jobType)
  if (t?.category) return t.category
  if (String(jobType).startsWith('collect')) return 'collect'
  if (String(jobType).startsWith('condition')) return 'condition'
  if (String(jobType) === 'bet.stop_loss' || String(jobType).startsWith('stop')) return 'stop'
  if (String(jobType).startsWith('bet')) return 'betting'
  return 'collect'
}

function optionsForCategory(cat) {
  return nameOptions.value?.[cat] || []
}

const formNameOptions = computed(() => optionsForCategory(categoryOfJobType(form.value.jobType)))

function pickDefaultNameKey(cat) {
  const list = optionsForCategory(cat)
  return list[0]?.key || ''
}

function optionByKey(cat, key) {
  return optionsForCategory(cat).find((o) => o.key === key) || null
}

function paramsFromOption(opt, cat) {
  if (!opt) return cat === 'collect' ? { category: 'collect' } : null
  if (cat === 'collect') return { category: 'collect' }
  return {
    category: cat,
    bucket: opt.bucket,
    groupIndex: opt.groupIndex,
    groupName: opt.groupName || opt.value,
  }
}

watch(
  () => form.value.jobType,
  (jt) => {
    form.value.nameKey = pickDefaultNameKey(categoryOfJobType(jt))
  },
)

async function refresh() {
  loading.value = true
  err.value = ''
  try {
    const [st, j] = await Promise.all([
      api.fetchSchedulerStatus(),
      api.fetchSchedulerJobs(),
    ])
    status.value = st
    jobs.value = j.jobs || []
    jobTypes.value = j.jobTypes || []
    nameOptions.value = j.nameOptions || { collect: [], condition: [], betting: [], stop: [] }
    if (!form.value.nameKey) {
      form.value.nameKey = pickDefaultNameKey(categoryOfJobType(form.value.jobType))
    }
    if (selectedJobId.value && !visibleJobs.value.find((x) => x.id === selectedJobId.value)) {
      selectedJobId.value = visibleJobs.value[0]?.id || ''
    }
    if (!selectedJobId.value && visibleJobs.value[0]) {
      selectedJobId.value = visibleJobs.value[0].id
    }
    if (selectedJobId.value) await loadRuns()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadRuns() {
  if (!selectedJobId.value) {
    runs.value = []
    return
  }
  try {
    const data = await api.fetchSchedulerRuns(selectedJobId.value, { limit: 50 })
    runs.value = data.runs || []
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '日志加载失败'
  }
}

async function clearRuns() {
  if (!selectedJobId.value) {
    err.value = '请先选择任务'
    return
  }
  const job = jobs.value.find((j) => j.id === selectedJobId.value)
  const name = job?.name || selectedJobId.value
  if (!confirm(`确认清空任务「${name}」的全部运行日志？`)) return
  msg.value = ''
  err.value = ''
  try {
    const r = await api.clearSchedulerRuns(selectedJobId.value)
    runs.value = []
    msg.value = `已清空日志（${r.deleted ?? 0} 条）`
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '清空失败'
  }
}

function openCreateModal() {
  const next = defaultForm()
  next.nameKey = pickDefaultNameKey(categoryOfJobType(next.jobType))
  form.value = next
  createOpen.value = true
}

function closeCreateModal() {
  createOpen.value = false
}

async function createJob() {
  msg.value = ''
  err.value = ''
  const cat = categoryOfJobType(form.value.jobType)
  const opt = optionByKey(cat, form.value.nameKey)
  if (!form.value.nameKey || !opt) {
    const tip = {
      collect: '请选择名称',
      condition: '请先在条件引擎配置分组，再选择名称',
      betting: '请先在投注引擎配置分组，再选择名称',
      stop: '请先在止损/投注引擎配置分组，再选择名称',
    }
    err.value = tip[cat] || '请选择名称'
    return
  }
  creating.value = true
  try {
    const payload = {
      name: opt.value,
      jobType: form.value.jobType,
      scheduleMode: form.value.scheduleMode,
      enabled: form.value.enabled,
      params: paramsFromOption(opt, cat),
    }
    if (form.value.scheduleMode === 'interval') {
      payload.intervalSec = Number(form.value.intervalSec)
    } else {
      payload.dailyTime = form.value.dailyTime
    }
    const r = await api.createSchedulerJob(payload)
    msg.value = `已新增：${r.job?.name || r.job?.id}`
    if (r.job?.id) selectedJobId.value = r.job.id
    createOpen.value = false
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  } finally {
    creating.value = false
  }
}

async function toggleJob(job, enabled) {
  msg.value = ''
  try {
    if (enabled) await api.enableSchedulerJob(job.id)
    else await api.disableSchedulerJob(job.id)
    msg.value = enabled ? `已启用 ${job.name}` : `已停用 ${job.name}`
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
}

async function runNow(job) {
  msg.value = ''
  err.value = ''
  try {
    const r = await api.runSchedulerJob(job.id)
    msg.value = `立即执行：${job.name} · ${r.status || 'ok'} · ${r.runId || ''}`
    selectedJobId.value = job.id
    await loadRuns()
    await nextTick()
    logBox.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
}

async function showLogs(job) {
  selectedJobId.value = job.id
  await loadRuns()
  await nextTick()
  logBox.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function removeJob(job) {
  if (!confirm(`确认删除任务「${job.name}」？运行日志一并删除。`)) return
  msg.value = ''
  err.value = ''
  try {
    await api.deleteSchedulerJob(job.id)
    msg.value = `已删除：${job.name}`
    if (selectedJobId.value === job.id) selectedJobId.value = ''
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '删除失败'
  }
}

function scheduleText(job) {
  if (job.scheduleMode === 'daily') return `每天 ${job.dailyTime || job.cronExpr || '--'}（北京时间）`
  return `每隔 ${job.intervalSec} 秒`
}

function statusClass(s) {
  if (s === 'success') return 'ok'
  if (s === 'failed' || s === 'timeout') return 'fail'
  if (s === 'skipped') return 'skip'
  if (s === 'running') return 'run'
  return ''
}

function startLogTimer() {
  stopLogTimer()
  if (!autoRefreshLogs.value) return
  logTimer = setInterval(() => {
    if (selectedJobId.value) loadRuns()
  }, 5000)
}

function stopLogTimer() {
  if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
}

watch(autoRefreshLogs, startLogTimer)
watch(selectedJobId, (id) => {
  if (id) loadRuns()
  else runs.value = []
})
watch(createOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
})

onMounted(() => {
  refresh()
  startLogTimer()
})
onUnmounted(() => {
  stopLogTimer()
  document.body.style.overflow = ''
})
</script>

<template>
  <div class="sched">
    <div class="card head">
      <div class="head-row">
        <div>
          <div class="title">调度中心</div>
          <p class="sub">管理定时任务 · 立即执行 · 查看运行日志</p>
        </div>
        <div class="head-actions">
          <button type="button" class="btn ghost" :disabled="loading" @click="refresh">刷新</button>
          <button type="button" class="btn primary" @click="openCreateModal">新增任务</button>
        </div>
      </div>
      <div v-if="status" class="status-line">
        调度循环：
        <span :class="status.running ? 'ok' : 'fail'">{{ status.running ? '运行中' : '未启动' }}</span>
        · 任务 {{ status.enabledCount }}/{{ status.jobCount }} 启用
      </div>
      <p v-if="msg" class="tip ok">{{ msg }}</p>
      <p v-if="err" class="tip fail">{{ err }}</p>
    </div>

    <div class="card jobs-card">
      <div class="jobs-head">
        <div class="sec-title">
          任务列表
          <span class="count">{{ visibleJobs.length }}</span>
        </div>
      </div>
      <div v-if="!visibleJobs.length" class="empty">暂无任务，点击右上角「新增任务」</div>
      <div v-else class="jobs-table-wrap">
        <table class="jobs-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>计划</th>
              <th>状态</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="job in visibleJobs"
              :key="job.id"
              :class="{ active: selectedJobId === job.id }"
              @click="selectedJobId = job.id"
            >
              <td class="col-name">
                <div class="job-name">{{ job.name }}</div>
                <div v-if="job.params?.bucket" class="job-sub">{{ job.params.bucket }}#{{ job.params.groupIndex }}</div>
              </td>
              <td class="col-type">{{ job.jobTypeLabel || job.jobType }}</td>
              <td class="col-sched">{{ scheduleText(job) }}</td>
              <td class="col-state">
                <span class="badge" :class="job.enabled ? 'on' : 'off'">{{ job.enabled ? '启用' : '停用' }}</span>
              </td>
              <td class="col-actions" @click.stop>
                <div class="job-actions">
                  <button type="button" class="link-btn" @click="toggleJob(job, !job.enabled)">
                    {{ job.enabled ? '停用' : '启用' }}
                  </button>
                  <button type="button" class="link-btn primary" @click="runNow(job)">执行</button>
                  <button type="button" class="link-btn" @click="showLogs(job)">日志</button>
                  <button type="button" class="link-btn danger" @click="removeJob(job)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div ref="logBox" class="card log-card">
      <div class="log-head">
        <div class="sec-title">运行日志</div>
        <div class="log-tools">
          <select v-model="selectedJobId" class="job-select">
            <option value="">选择任务</option>
            <option v-for="j in visibleJobs" :key="j.id" :value="j.id">{{ j.name }}</option>
          </select>
          <label class="check inline">
            <input v-model="autoRefreshLogs" type="checkbox" />
            自动刷新
          </label>
          <button
            type="button"
            class="btn sm ghost"
            :disabled="!selectedJobId"
            @click="loadRuns"
          >刷新日志</button>
          <button
            type="button"
            class="btn sm danger"
            :disabled="!selectedJobId || !runs.length"
            @click="clearRuns"
          >清空日志</button>
        </div>
      </div>
      <div v-if="!selectedJobId" class="empty">请选择任务查看日志</div>
      <div v-else-if="!runs.length" class="empty">暂无运行记录</div>
      <div v-else class="log-scroll">
        <table class="log-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>触发</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.runId">
              <td class="nowrap">{{ r.startedAt }}</td>
              <td>{{ r.trigger }}</td>
              <td :class="statusClass(r.status)">{{ r.status }}</td>
              <td class="msg" :title="r.error || r.message || r.runId">
                {{ r.error || r.message || r.runId }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="createOpen" class="modal-mask" @click.self="closeCreateModal">
        <div class="modal-panel" role="dialog" aria-modal="true" aria-label="新增调度任务">
          <header class="modal-head">
            <div class="modal-title">新增任务</div>
            <button type="button" class="btn ghost sm" @click="closeCreateModal">关闭</button>
          </header>
          <div class="modal-body">
            <div class="form-grid">
              <label>
                <span>任务类型</span>
                <select v-model="form.jobType">
                  <optgroup v-for="g in jobTypeGroups" :key="g.category" :label="g.label">
                    <option v-for="t in g.items" :key="t.jobType" :value="t.jobType">{{ t.label }}</option>
                  </optgroup>
                </select>
              </label>
              <label>
                <span>名称</span>
                <select v-model="form.nameKey" :disabled="!formNameOptions.length">
                  <option value="" disabled>
                    {{ formNameOptions.length ? '请选择' : '暂无分组（请先在条件/投注引擎配置）' }}
                  </option>
                  <option v-for="o in formNameOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
                </select>
              </label>
              <label>
                <span>时间方式</span>
                <select v-model="form.scheduleMode">
                  <option value="interval">每隔 N 秒</option>
                  <option value="daily">每天定点（北京时间）</option>
                </select>
              </label>
              <label v-if="form.scheduleMode === 'interval'">
                <span>间隔（秒）</span>
                <input v-model.number="form.intervalSec" type="number" min="1" />
              </label>
              <label v-else>
                <span>每天时刻</span>
                <input v-model="form.dailyTime" type="time" />
              </label>
            </div>
            <label class="check">
              <input v-model="form.enabled" type="checkbox" />
              创建并启用
            </label>
          </div>
          <footer class="modal-foot">
            <button type="button" class="btn ghost" :disabled="creating" @click="closeCreateModal">取消</button>
            <button type="button" class="btn primary" :disabled="creating" @click="createJob">
              {{ creating ? '创建中…' : '确认新增' }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sched {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.card {
  background: #fff;
  border-radius: 16px;
  padding: 16px;
  box-shadow: 0 1px 2px rgb(15 23 42 / 6%);
}
.jobs-card {
  padding: 12px 14px;
}
.head-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.title {
  font-weight: 700;
  font-size: 15px;
}
.sub, .status-line, .empty {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 4px;
}
.sec-title {
  font-weight: 650;
  font-size: 13px;
  margin-bottom: 10px;
}
.sec-title .count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  margin-left: 6px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 10px;
  font-weight: 700;
}
.jobs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.jobs-head .sec-title {
  margin-bottom: 0;
}
.jobs-table-wrap {
  overflow: auto;
  border: 1px solid #f1f5f9;
  border-radius: 10px;
}
.jobs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.jobs-table th {
  padding: 6px 8px;
  text-align: left;
  font-size: 10px;
  font-weight: 700;
  color: #94a3b8;
  background: #f8fafc;
  white-space: nowrap;
}
.jobs-table td {
  padding: 6px 8px;
  border-top: 1px solid #f1f5f9;
  vertical-align: middle;
  color: #475569;
}
.jobs-table tbody tr {
  cursor: pointer;
}
.jobs-table tbody tr:hover {
  background: #f8fafc;
}
.jobs-table tbody tr.active {
  background: #f0f7ff;
}
.col-name { min-width: 120px; }
.col-type { min-width: 100px; color: #64748b; font-size: 11px; }
.col-sched { min-width: 110px; color: #64748b; font-size: 11px; white-space: nowrap; }
.col-state { width: 64px; }
.col-actions { width: 1%; white-space: nowrap; }
.job-name {
  font-size: 12px;
  font-weight: 650;
  color: #0f172a;
  line-height: 1.3;
}
.job-sub {
  font-size: 10px;
  color: #94a3b8;
  margin-top: 1px;
}
.job-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  justify-content: flex-end;
}
.link-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  cursor: pointer;
}
.link-btn:hover { color: #2563eb; }
.link-btn.primary { color: #2563eb; }
.link-btn.danger { color: #e11d48; }
.link-btn.danger:hover { color: #be123c; }
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: max(12px, env(safe-area-inset-top, 0px)) 16px max(12px, env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
  overflow-y: auto;
}
.modal-panel {
  width: min(520px, calc(100vw - 32px));
  margin: auto 0;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.2);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #e2e8f0;
}
.modal-title {
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}
.modal-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.modal-body .check {
  margin: 0;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px 14px;
  border-top: 1px solid #e2e8f0;
}
.tip {
  font-size: 12px;
  margin-top: 8px;
}
.tip.ok, .ok { color: #059669; }
.tip.fail, .fail { color: #e11d48; }
.skip { color: #d97706; }
.run { color: #0284c7; }
.form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
@media (min-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr 1fr;
  }
}
label span {
  display: block;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 4px;
}
select, input[type='number'], input[type='time'], .job-select {
  width: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 8px 12px;
  font-size: 13px;
  background: #fff;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #475569;
  margin: 10px 0;
}
.check.inline {
  margin: 0;
  white-space: nowrap;
}
.btn {
  border: none;
  border-radius: 12px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.primary {
  background: #2563eb;
  color: #fff;
}
.btn.ghost {
  background: #fff;
  border: 1px solid #e2e8f0;
  color: #475569;
}
.btn.danger {
  background: #fff;
  border: 1px solid #fecdd3;
  color: #e11d48;
}
.btn.sm {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
}
.badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  white-space: nowrap;
}
.badge.on {
  background: #ecfdf5;
  color: #047857;
}
.badge.off {
  background: #f1f5f9;
  color: #64748b;
}
.log-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.log-head .sec-title {
  margin-bottom: 0;
}
.log-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.job-select {
  width: auto;
  min-width: 140px;
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 8px;
}
.log-scroll {
  max-height: 320px;
  overflow: auto;
  border: 1px solid #f1f5f9;
  border-radius: 10px;
}
.log-table {
  width: 100%;
  border-collapse: collapse;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  text-align: left;
}
.log-table th {
  position: sticky;
  top: 0;
  background: #f8fafc;
  color: #94a3b8;
  font-weight: 600;
  padding: 6px 8px;
}
.log-table td {
  padding: 6px 8px;
  border-top: 1px solid #f8fafc;
  color: #475569;
  vertical-align: top;
}
.log-table .nowrap {
  white-space: nowrap;
}
.log-table .msg {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
