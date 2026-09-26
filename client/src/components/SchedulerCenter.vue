<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import * as api from '../api'

const loading = ref(false)
const status = ref(null)
const jobs = ref([])
const jobTypes = ref([])
const nameOptions = ref({ collect: [], condition: [], stop: [] })
const selectedJobId = ref('')
const runs = ref([])
const msg = ref('')
const err = ref('')
const autoRefreshLogs = ref(true)
let logTimer = null

const createOpen = ref(false)
const logOpen = ref(false)
const creating = ref(false)
const detailOpen = ref(false)
const detailRun = ref(null)

const tgOpen = ref(false)
const tgSaving = ref(false)
const tgTesting = ref(false)
const tgForm = ref({
  enabled: false,
  notifyManual: true,
  chatId: '',
  botToken: '',
  botTokenSet: false,
  botTokenPreview: '',
})

function defaultForm() {
  return {
    nameKey: 'collect:top100',
    jobType: 'collect.top100',
    scheduleMode: 'interval',
    intervalSec: 6 * 3600,
    dailyTime: '09:00',
    enabled: true,
  }
}

const form = ref(defaultForm())

const HIDDEN_JOB_TYPES = new Set(['collect.full', 'collect.top100_hf', 'bet.scan'])

/** 任务类型展示名（覆盖 API 旧 label） */
const JOB_TYPE_LABELS = {
  'collect.top100': 'Top100 全量采集',
  'collect.inplay_tick': '盘中迁桶',
  'collect.dota2': 'Dota2 采集',
  'collect.dota2_hf': 'Dota2 高频采集',
  'collect.nfl': 'NFL 采集',
  'collect.nfl_hf': 'NFL 高频采集',
  'condition.query': '条件引擎 · 查询筛选',
  'bet.stop_loss': '止损引擎 · 持仓止损扫描',
}

const JOB_TYPE_META = {
  'collect.top100': {
    category: 'collect',
    intervalUnit: 'hour',
    intervalPresets: [6, 12],
    defaultIntervalSec: 6 * 3600,
    defaultName: 'Top100 全量采集',
  },
  'collect.inplay_tick': {
    category: 'collect',
    intervalUnit: 'second',
    intervalPresets: [30, 60, 120],
    defaultIntervalSec: 60,
    defaultName: '盘中迁桶',
  },
  'collect.dota2': {
    category: 'collect',
    intervalUnit: 'second',
    intervalPresets: [30, 60, 90, 120],
    defaultIntervalSec: 90,
    defaultName: 'Dota2 采集',
  },
  'collect.dota2_hf': {
    category: 'collect',
    intervalUnit: 'second',
    intervalPresets: [10, 30, 60, 120],
    defaultIntervalSec: 30,
    defaultName: 'Dota2 高频采集',
  },
  'collect.nfl': {
    category: 'collect',
    intervalUnit: 'second',
    intervalPresets: [30, 60, 90, 120],
    defaultIntervalSec: 90,
    defaultName: 'NFL 采集',
  },
  'collect.nfl_hf': {
    category: 'collect',
    intervalUnit: 'second',
    intervalPresets: [10, 30, 60, 120],
    defaultIntervalSec: 30,
    defaultName: 'NFL 高频采集',
  },
}

const DEFAULT_JOB_TYPES = [
  { jobType: 'collect.top100', category: 'collect' },
  { jobType: 'collect.inplay_tick', category: 'collect' },
  { jobType: 'collect.dota2', category: 'collect' },
  { jobType: 'collect.dota2_hf', category: 'collect' },
  { jobType: 'collect.nfl', category: 'collect' },
  { jobType: 'collect.nfl_hf', category: 'collect' },
  { jobType: 'condition.query', category: 'condition' },
  { jobType: 'bet.stop_loss', category: 'stop' },
]

function normalizeJobTypeDef(raw) {
  const jobType = raw?.jobType || raw?.job_type
  if (!jobType) return null
  const meta = JOB_TYPE_META[jobType] || {}
  return {
    ...raw,
    jobType,
    ...meta,
    label: JOB_TYPE_LABELS[jobType] || raw.label || jobType,
    category: meta.category || raw.category || categoryOfJobTypeStatic(jobType),
    hidden: raw.hidden || HIDDEN_JOB_TYPES.has(jobType),
  }
}

function categoryOfJobTypeStatic(jobType) {
  if (String(jobType).startsWith('collect')) return 'collect'
  if (String(jobType).startsWith('condition')) return 'condition'
  if (String(jobType) === 'bet.stop_loss' || String(jobType).startsWith('stop')) return 'stop'
  return 'collect'
}

function displayJobTypeLabel(job) {
  const jt = job?.jobType || job?.job_type
  return JOB_TYPE_LABELS[jt] || job?.jobTypeLabel || jt || '—'
}

const jobTypeOptions = computed(() => {
  const rawList = jobTypes.value.length ? jobTypes.value : DEFAULT_JOB_TYPES
  const byType = new Map()
  for (const raw of rawList) {
    const t = normalizeJobTypeDef(raw)
    if (t) byType.set(t.jobType, t)
  }
  for (const raw of DEFAULT_JOB_TYPES) {
    if (!byType.has(raw.jobType)) {
      const t = normalizeJobTypeDef(raw)
      if (t) byType.set(t.jobType, t)
    }
  }
  return [...byType.values()]
    .map((t) => normalizeJobTypeDef(t))
    .filter((t) => t && !t.hidden && !HIDDEN_JOB_TYPES.has(t.jobType))
})

const isCollectJobType = computed(() => categoryOfJobType(form.value.jobType) === 'collect')
const isInplayTickJobType = computed(() =>
  form.value.jobType === 'collect.inplay_tick'
  || form.value.jobType === 'collect.dota2'
  || form.value.jobType === 'collect.dota2_hf'
  || form.value.jobType === 'collect.nfl'
  || form.value.jobType === 'collect.nfl_hf',
)

const collectIntervalPresets = computed(() => {
  const def = jobTypeOptions.value.find((t) => t.jobType === form.value.jobType)
  if (!def?.intervalPresets?.length) return []
  const unit = def.intervalUnit || 'second'
  return def.intervalPresets.map((n) => ({
    sec: unit === 'hour' ? n * 3600 : n,
    label: unit === 'hour' ? `${n} 小时` : `${n} 秒`,
  }))
})

function jobTypeDef(jobType) {
  return jobTypeOptions.value.find((t) => t.jobType === jobType)
}

function applyCollectDefaults(jobType) {
  const def = jobTypeDef(jobType)
  if (!def || categoryOfJobType(jobType) !== 'collect') return
  const match = optionsForCategory('collect').find((o) => o.jobType === jobType)
  form.value.nameKey = match?.key || form.value.nameKey
  form.value.scheduleMode = 'interval'
  form.value.intervalSec = def.defaultIntervalSec || form.value.intervalSec
}

const CATEGORY_LABELS = {
  collect: '采集引擎',
  condition: '条件引擎',
  stop: '止损引擎',
}

const CATEGORY_ORDER = ['collect', 'condition', 'stop']

const DEFAULT_JOB_TYPE_BY_CATEGORY = {
  collect: 'collect.top100',
  condition: 'condition.query',
  stop: 'bet.stop_loss',
}

const activeTab = ref('collect')

const visibleJobs = computed(() => jobs.value.filter((j) => {
  const jt = j.jobType || j.job_type
  return !HIDDEN_JOB_TYPES.has(jt)
}))

function isCollectSlotTaken(jobType) {
  return visibleJobs.value.some((j) => (j.jobType || j.job_type) === jobType)
}

function isGroupSlotTaken(jobType, bucket, groupIndex) {
  return visibleJobs.value.some((j) => {
    if ((j.jobType || j.job_type) !== jobType) return false
    const p = j.params || {}
    return String(p.bucket ?? '') === String(bucket ?? '')
      && Number(p.groupIndex) === Number(groupIndex)
  })
}

function isJobTypeCreatable(jobType) {
  const cat = categoryOfJobTypeStatic(jobType)
  if (cat === 'collect') return !isCollectSlotTaken(jobType)
  const list = optionsForCategory(cat)
  return list.some((o) => !isGroupSlotTaken(jobType, o.bucket, o.groupIndex))
}

const creatableJobTypeOptions = computed(() =>
  jobTypeOptions.value.filter((t) => isJobTypeCreatable(t.jobType)),
)

const canCreateInActiveTab = computed(() =>
  jobTypeOptions.value.some(
    (t) => (t.category || categoryOfJobType(t.jobType)) === activeTab.value
      && isJobTypeCreatable(t.jobType),
  ),
)

const creatableJobTypeGroups = computed(() => {
  const order = ['collect', 'condition', 'stop']
  const map = { collect: [], condition: [], stop: [] }
  for (const t of creatableJobTypeOptions.value) {
    const cat = t.category || categoryOfJobType(t.jobType)
    if (!map[cat]) map[cat] = []
    map[cat].push(t)
  }
  return order
    .filter((cat) => map[cat]?.length)
    .map((cat) => ({ category: cat, label: CATEGORY_LABELS[cat] || cat, items: map[cat] }))
})

function jobCategory(job) {
  const jt = job?.jobType || job?.job_type
  return categoryOfJobType(jt)
}

const categoryTabs = computed(() =>
  CATEGORY_ORDER.map((cat) => {
    const list = visibleJobs.value.filter((j) => jobCategory(j) === cat)
    return {
      id: cat,
      label: CATEGORY_LABELS[cat] || cat,
      count: list.length,
      enabledCount: list.filter((j) => j.enabled).length,
    }
  }),
)

const tabJobs = computed(() => visibleJobs.value.filter((j) => jobCategory(j) === activeTab.value))

const activeTabLabel = computed(() => CATEGORY_LABELS[activeTab.value] || activeTab.value)

const logJob = computed(() => visibleJobs.value.find((j) => j.id === selectedJobId.value) || null)

const jobTypeGroups = computed(() => {
  const order = ['collect', 'condition', 'stop']
  const map = { collect: [], condition: [], stop: [] }
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
  return 'collect'
}

function optionsForCategory(cat) {
  return nameOptions.value?.[cat] || []
}

const formNameOptions = computed(() => {
  const jt = form.value.jobType
  const cat = categoryOfJobType(jt)
  const list = optionsForCategory(cat)
  if (cat === 'collect') {
    if (isCollectSlotTaken(jt)) return []
    return list.filter((o) => o.jobType === jt)
  }
  return list.filter((o) => !isGroupSlotTaken(jt, o.bucket, o.groupIndex))
})

function pickDefaultNameKey(cat, jobType) {
  const jt = jobType || form.value.jobType
  const list = optionsForCategory(cat)
  if (cat === 'collect') {
    const hit = list.find((o) => o.jobType === jt && !isCollectSlotTaken(jt))
    return hit?.key || ''
  }
  const hit = list.find((o) => !isGroupSlotTaken(jt, o.bucket, o.groupIndex))
  return hit?.key || ''
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
    if (categoryOfJobType(jt) === 'collect') {
      applyCollectDefaults(jt)
    } else {
      form.value.nameKey = pickDefaultNameKey(categoryOfJobType(jt), jt)
    }
  },
)

async function loadTelegramConfig() {
  try {
    const data = await api.fetchSchedulerTelegram()
    const c = data?.config || {}
    tgForm.value = {
      enabled: !!c.enabled,
      notifyManual: c.notifyManual !== false,
      chatId: c.chatId || '',
      botToken: '',
      botTokenSet: !!c.botTokenSet,
      botTokenPreview: c.botTokenPreview || '',
    }
  } catch {
    /* ignore */
  }
}

async function saveTelegramConfig() {
  tgSaving.value = true
  err.value = ''
  msg.value = ''
  try {
    const payload = {
      enabled: tgForm.value.enabled,
      notifyManual: tgForm.value.notifyManual,
      chatId: tgForm.value.chatId,
    }
    if (tgForm.value.botToken.trim()) payload.botToken = tgForm.value.botToken.trim()
    const data = await api.saveSchedulerTelegram(payload)
    const c = data?.config || {}
    tgForm.value.botToken = ''
    tgForm.value.botTokenSet = !!c.botTokenSet
    tgForm.value.botTokenPreview = c.botTokenPreview || ''
    msg.value = '保存成功'
  } catch (e) {
    err.value = `保存失败：${e?.response?.data?.error || e.message || '请重试'}`
  } finally {
    tgSaving.value = false
  }
}

async function testTelegramConfig() {
  tgTesting.value = true
  err.value = ''
  msg.value = ''
  try {
    if (tgForm.value.botToken.trim()) {
      await saveTelegramConfig()
    }
    await api.testSchedulerTelegram()
    msg.value = '测试消息已发送，请查看 Telegram'
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '测试发送失败'
  } finally {
    tgTesting.value = false
  }
}

async function refresh() {
  if (loading.value) return
  loading.value = true
  err.value = ''
  try {
    const [st, j] = await Promise.all([
      api.fetchSchedulerStatus(),
      api.fetchSchedulerJobs(),
    ])
    await loadTelegramConfig()
    status.value = st
    jobs.value = j.jobs || []
    jobTypes.value = j.jobTypes || []
    nameOptions.value = j.nameOptions || { collect: [], condition: [], stop: [] }
    if (!form.value.nameKey) {
      form.value.nameKey = pickDefaultNameKey(
        categoryOfJobType(form.value.jobType),
        form.value.jobType,
      )
    }
    if (selectedJobId.value) {
      const selected = visibleJobs.value.find((x) => x.id === selectedJobId.value)
      if (!selected) {
        selectedJobId.value = ''
        logOpen.value = false
      } else if (logOpen.value) {
        activeTab.value = jobCategory(selected)
      }
    }
    if (logOpen.value && selectedJobId.value) void loadRuns()
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

function formatRunDetail(r) {
  if (!r) return ''
  const m = r.metrics
  if (!m || typeof m !== 'object') {
    return [r.error, r.message].filter(Boolean).join('\n') || '暂无详细日志（本次未写入 metrics）'
  }
  const parts = []
  let proc = m.process_log
    || m.log_tail
    || m.refresh_inplay?.process_log
    || m.refresh_inplay?.log_tail
    || m.prices?.process_log
    || ''
  if (!proc && (m.scores || m.prices || m.inplay_matches != null)) {
    proc = [
      `[inplay-tick] matches=${m.inplay_matches ?? '-'}`,
      m.scores
        ? `[score] updated=${m.scores.updated ?? 0} failed=${m.scores.failed ?? 0} error=${m.scores.error || '-'}`
        : null,
      m.prices
        ? `[odds] updated=${m.prices.updated ?? 0} failed=${m.prices.failed ?? 0}`
        : null,
      m.message || m.reason || null,
    ].filter(Boolean).join('\n')
  }
  if (proc) {
    parts.push(`=== 采集过程日志 ===\n${proc}`)
  } else {
    parts.push(
      '=== 采集过程日志 ===\n'
      + '(本次记录未包含过程日志。请部署最新代码后重新执行一轮「盘中赔率刷新」。)',
    )
  }
  if (m.score_failures) {
    parts.push(`=== 比分失败 ===\n${JSON.stringify(m.score_failures, null, 2)}`)
  }
  if (m.odds_failures?.length || m.prices?.failures?.length) {
    parts.push(
      `=== 赔率失败 ===\n${JSON.stringify(m.odds_failures || m.prices.failures, null, 2)}`,
    )
  }
  // 完整 metrics，避免只看到精简汇总
  parts.push(`=== 完整 metrics ===\n${JSON.stringify(m, null, 2)}`)
  if (r.error) parts.unshift(`=== 错误 ===\n${r.error}`)
  if (r.message) parts.unshift(`=== 说明 ===\n${r.message}`)
  return parts.join('\n\n')
}

function openRunDetail(r) {
  detailRun.value = r
  detailOpen.value = true
}

function closeRunDetail() {
  detailOpen.value = false
  detailRun.value = null
}

function pickCreatableJobTypeForTab(tab) {
  const hit = creatableJobTypeOptions.value.find(
    (t) => (t.category || categoryOfJobType(t.jobType)) === tab,
  )
  return hit?.jobType || creatableJobTypeOptions.value[0]?.jobType || ''
}

function openCreateModal() {
  if (!canCreateInActiveTab.value) {
    err.value = `「${activeTabLabel.value}」下可添加的调度已全部创建`
    return
  }
  const next = defaultForm()
  const jt = pickCreatableJobTypeForTab(activeTab.value)
  if (!jt) {
    err.value = '暂无可新增的任务类型'
    return
  }
  next.jobType = jt
  form.value = next
  applyCollectDefaults(next.jobType)
  if (categoryOfJobType(next.jobType) !== 'collect') {
    form.value.nameKey = pickDefaultNameKey(categoryOfJobType(next.jobType), next.jobType)
  }
  createOpen.value = true
}

function closeCreateModal() {
  createOpen.value = false
}

async function createJob() {
  msg.value = ''
  err.value = ''
  const cat = categoryOfJobType(form.value.jobType)
  const isCollect = cat === 'collect'
  const def = jobTypeDef(form.value.jobType)
  let name = ''
  let params = null
  if (isCollect) {
    if (isCollectSlotTaken(form.value.jobType)) {
      err.value = `「${JOB_TYPE_LABELS[form.value.jobType] || form.value.jobType}」已存在，无需重复添加`
      return
    }
    const opt = optionByKey('collect', form.value.nameKey)
    name = opt?.value || def?.defaultName || def?.label || '采集'
    params = { category: 'collect' }
    if (!form.value.intervalSec || form.value.intervalSec <= 0) {
      err.value = '请选择采集间隔'
      return
    }
    if (form.value.jobType === 'collect.inplay_tick' && Number(form.value.intervalSec) < 10) {
      err.value = '盘中迁桶间隔至少 10 秒'
      return
    }
  } else {
    const opt = optionByKey(cat, form.value.nameKey)
    if (!form.value.nameKey || !opt) {
      const tip = {
        condition: '请先在条件引擎配置分组，再选择名称',
        stop: '请先在止损引擎配置分组，再选择名称',
      }
      err.value = tip[cat] || '请选择名称'
      return
    }
    if (isGroupSlotTaken(form.value.jobType, opt.bucket, opt.groupIndex)) {
      err.value = `「${opt.label || opt.value}」已存在调度，无需重复添加`
      return
    }
    name = opt.value
    params = paramsFromOption(opt, cat)
  }
  creating.value = true
  try {
    const payload = {
      name,
      jobType: form.value.jobType,
      scheduleMode: isCollect ? 'interval' : form.value.scheduleMode,
      enabled: form.value.enabled,
      params,
    }
    if (payload.scheduleMode === 'interval') {
      payload.intervalSec = Number(form.value.intervalSec)
    } else {
      payload.dailyTime = form.value.dailyTime
    }
    const r = await api.createSchedulerJob(payload)
    msg.value = `已新增：${r.job?.name || r.job?.id}`
    if (r.job?.id) {
      activeTab.value = jobCategory(r.job)
      selectedJobId.value = r.job.id
    }
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
    await openLogModal(job)
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
}

function closeLogModal() {
  logOpen.value = false
  stopLogTimer()
  closeRunDetail()
}

async function openLogModal(job) {
  selectedJobId.value = job.id
  logOpen.value = true
  await loadRuns()
  startLogTimer()
}

async function showLogs(job) {
  await openLogModal(job)
}

async function removeJob(job) {
  if (!confirm(`确认删除任务「${job.name}」？运行日志一并删除。`)) return
  msg.value = ''
  err.value = ''
  try {
    await api.deleteSchedulerJob(job.id)
    msg.value = `已删除：${job.name}`
    if (selectedJobId.value === job.id) {
      selectedJobId.value = ''
      logOpen.value = false
      stopLogTimer()
    }
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '删除失败'
  }
}

function scheduleText(job) {
  if (job.scheduleMode === 'daily') return `每天 ${job.dailyTime || job.cronExpr || '--'}（北京时间）`
  const sec = Number(job.intervalSec)
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec % 3600 === 0 && sec >= 3600) return `每隔 ${sec / 3600} 小时`
  if (sec % 60 === 0 && sec >= 60) return `每隔 ${sec / 60} 分钟`
  return `每隔 ${sec} 秒`
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
  if (!autoRefreshLogs.value || !logOpen.value) return
  logTimer = setInterval(() => {
    if (selectedJobId.value && logOpen.value) loadRuns()
  }, 5000)
}

function stopLogTimer() {
  if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
}

watch(autoRefreshLogs, startLogTimer)
watch(logOpen, (open) => {
  if (open) startLogTimer()
  else stopLogTimer()
})
watch([createOpen, logOpen], ([create, log]) => {
  document.body.style.overflow = create || log ? 'hidden' : ''
})

onMounted(() => {
  refresh()
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
          <button type="button" class="btn ghost" :disabled="loading" @click="() => void refresh()">刷新</button>
          <button
            type="button"
            class="btn primary"
            :disabled="!canCreateInActiveTab"
            :title="canCreateInActiveTab ? '新增当前分类下未创建的调度' : '当前分类可添加的调度已全部创建'"
            @click="openCreateModal"
          >新增任务</button>
        </div>
      </div>
      <div v-if="status" class="status-line">
        调度循环：
        <span :class="status.running ? 'ok' : 'fail'">{{ status.running ? '运行中' : '未启动' }}</span>
        · 任务 {{ status.enabledCount }}/{{ status.jobCount }} 启用
        · Telegram
        <span :class="tgForm.enabled && tgForm.botTokenSet ? 'ok' : 'fail'">
          {{ tgForm.enabled && tgForm.botTokenSet ? '已开' : '未配置' }}
        </span>
      </div>
      <details class="tg-panel" :open="tgOpen" @toggle="tgOpen = $event.target.open">
        <summary class="tg-summary">Telegram 通知设置</summary>
        <div class="tg-body">
          <p class="sub tg-hint">
            在 @BotFather 创建机器人获取 Token；与机器人对话或将其加入群组后，用 @userinfobot 等获取 Chat ID。
            任务每次执行完成（成功/失败/跳过/超时）会推送通知。
          </p>
          <div class="tg-grid">
            <label class="check inline">
              <input v-model="tgForm.enabled" type="checkbox" />
              启用通知
            </label>
            <label class="check inline">
              <input v-model="tgForm.notifyManual" type="checkbox" />
              手动「执行」也通知
            </label>
            <label>
              <span>Bot Token</span>
              <input
                v-model="tgForm.botToken"
                type="password"
                autocomplete="off"
                :placeholder="tgForm.botTokenSet ? `已保存 ${tgForm.botTokenPreview}` : '123456:ABC-DEF…'"
              />
            </label>
            <label>
              <span>Chat ID</span>
              <input v-model.trim="tgForm.chatId" type="text" placeholder="你的用户 ID 或群组 ID" />
            </label>
          </div>
          <div class="tg-actions">
            <button type="button" class="btn ghost sm" :disabled="tgSaving || tgTesting" @click="saveTelegramConfig">
              {{ tgSaving ? '保存中…' : '保存' }}
            </button>
            <button type="button" class="btn ghost sm" :disabled="tgTesting || tgSaving" @click="testTelegramConfig">
              {{ tgTesting ? '发送中…' : '发送测试' }}
            </button>
          </div>
        </div>
      </details>
      <p v-if="msg" class="tip ok">{{ msg }}</p>
      <p v-if="err" class="tip fail">{{ err }}</p>
    </div>

    <div class="card jobs-card">
      <div class="jobs-head">
        <div class="sec-title">
          任务列表
          <span class="count">{{ tabJobs.length }}</span>
        </div>
      </div>
      <div class="category-tabs" role="tablist" aria-label="任务分类">
        <button
          v-for="t in categoryTabs"
          :key="t.id"
          type="button"
          class="category-tab"
          :class="{ on: activeTab === t.id, enabled: t.enabledCount > 0 }"
          role="tab"
          :aria-selected="activeTab === t.id"
          @click="activeTab = t.id"
        >
          {{ t.label }}
          <span v-if="t.count" class="tab-count">{{ t.count }}</span>
          <span class="dot" :class="{ on: t.enabledCount > 0 }" />
        </button>
      </div>
      <div v-if="!tabJobs.length" class="empty">
        {{ visibleJobs.length ? `「${activeTabLabel}」暂无任务` : '暂无任务' }}，点击右上角「新增任务」
      </div>
      <div v-else class="jobs-grid">
        <article
          v-for="job in tabJobs"
          :key="job.id"
          class="job-card"
          :class="{ on: job.enabled }"
        >
          <div class="job-card-top">
            <span class="badge" :class="job.enabled ? 'on' : 'off'">{{ job.enabled ? '启用' : '停用' }}</span>
          </div>
          <div class="job-name">{{ job.name }}</div>
          <div v-if="job.params?.bucket" class="job-sub">{{ job.params.bucket }}#{{ job.params.groupIndex }}</div>
          <div class="job-type">{{ displayJobTypeLabel(job) }}</div>
          <div class="job-sched">{{ scheduleText(job) }}</div>
          <div class="job-actions">
            <button type="button" class="link-btn" @click="toggleJob(job, !job.enabled)">
              {{ job.enabled ? '停用' : '启用' }}
            </button>
            <button type="button" class="link-btn primary" @click="runNow(job)">执行</button>
            <button type="button" class="link-btn" @click="showLogs(job)">日志</button>
            <button type="button" class="link-btn danger" @click="removeJob(job)">删除</button>
          </div>
        </article>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="logOpen" class="modal-mask" @click.self="closeLogModal">
        <div class="modal-panel log-modal" role="dialog" aria-modal="true" aria-label="运行日志">
          <header class="modal-head">
            <div>
              <div class="modal-title">运行日志</div>
              <div v-if="logJob" class="modal-sub">
                {{ logJob.name }}
                <span class="modal-sub-type">{{ displayJobTypeLabel(logJob) }}</span>
              </div>
            </div>
            <button type="button" class="btn ghost sm" @click="closeLogModal">关闭</button>
          </header>
          <div class="modal-body log-modal-body">
            <div class="log-tools">
              <label class="check inline">
                <input v-model="autoRefreshLogs" type="checkbox" />
                自动刷新
              </label>
              <button type="button" class="btn sm ghost" @click="loadRuns">刷新</button>
              <button
                type="button"
                class="btn sm danger"
                :disabled="!runs.length"
                @click="clearRuns"
              >清空日志</button>
            </div>
            <div v-if="!runs.length" class="empty">暂无运行记录</div>
            <div v-else class="log-scroll">
              <table class="log-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>触发</th>
                    <th>状态</th>
                    <th>说明</th>
                    <th class="col-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in runs" :key="r.runId">
                    <td class="nowrap">{{ r.startedAt }}</td>
                    <td>{{ r.trigger }}</td>
                    <td :class="statusClass(r.status)">{{ r.status }}</td>
                    <td class="msg">{{ r.error || r.message || r.runId }}</td>
                    <td class="col-act">
                      <button type="button" class="link-btn primary" @click="openRunDetail(r)">详细日志</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div v-if="detailOpen" class="modal-mask detail-mask" @click.self="closeRunDetail">
        <div class="modal-panel detail-modal" role="dialog" aria-modal="true" aria-label="详细日志">
          <header class="modal-head">
            <div>
              <div class="modal-title">详细日志</div>
              <div v-if="detailRun" class="modal-sub">
                {{ detailRun.startedAt }} · {{ detailRun.trigger }} · {{ detailRun.status }}
              </div>
            </div>
            <button type="button" class="btn ghost sm" @click="closeRunDetail">关闭</button>
          </header>
          <div class="modal-body detail-modal-body">
            <pre class="detail-pre">{{ formatRunDetail(detailRun) }}</pre>
          </div>
        </div>
      </div>

      <div v-if="createOpen" class="modal-mask" @click.self="closeCreateModal">        <div class="modal-panel" role="dialog" aria-modal="true" aria-label="新增调度任务">
          <header class="modal-head">
            <div class="modal-title">新增任务</div>
            <button type="button" class="btn ghost sm" @click="closeCreateModal">关闭</button>
          </header>
          <div class="modal-body">
            <div class="form-grid">
              <label>
                <span>任务类型</span>
                <select v-model="form.jobType">
                  <optgroup v-for="g in creatableJobTypeGroups" :key="g.category" :label="g.label">
                    <option v-for="t in g.items" :key="t.jobType" :value="t.jobType">{{ t.label }}</option>
                  </optgroup>
                </select>
              </label>
              <label v-if="!isCollectJobType">
                <span>名称</span>
                <select v-model="form.nameKey" :disabled="!formNameOptions.length">
                  <option value="" disabled>
                    {{ formNameOptions.length ? '请选择' : '暂无分组（请先在条件/止损引擎配置）' }}
                  </option>
                  <option v-for="o in formNameOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
                </select>
              </label>
              <template v-if="isCollectJobType">
                <label class="span-full">
                  <span>采集间隔</span>
                  <div class="interval-chips">
                    <button
                      v-for="p in collectIntervalPresets"
                      :key="p.sec"
                      type="button"
                      class="chip-btn"
                      :class="{ active: form.intervalSec === p.sec }"
                      @click="form.intervalSec = p.sec"
                    >{{ p.label }}</button>
                  </div>
                </label>
                <label v-if="isInplayTickJobType" class="span-full">
                  <span>自定义间隔（秒）</span>
                  <input
                    v-model.number="form.intervalSec"
                    type="number"
                    min="10"
                    step="1"
                    placeholder="如 45、90"
                  />
                  <span class="field-hint">预设可选，或自行填写（建议 ≥10 秒）</span>
                </label>
              </template>
              <template v-else>
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
              </template>
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
  padding: 16px 18px;
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
.category-tabs {
  display: flex;
  gap: 6px;
  margin: 0 0 10px;
  flex-wrap: wrap;
}
.category-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  font-size: 12px;
  font-weight: 650;
  color: #64748b;
  cursor: pointer;
}
.category-tab.on {
  background: #fff;
  color: #0f172a;
  border-color: #cbd5e1;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}
.category-tab .tab-count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #475569;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}
.category-tab.on .tab-count {
  background: #dbeafe;
  color: #1d4ed8;
}
.category-tab .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
  flex-shrink: 0;
}
.category-tab .dot.on {
  background: #10b981;
}
.jobs-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.job-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 148px;
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #f8fafc;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.job-card.on {
  background: #fff;
  border-color: #bfdbfe;
  box-shadow: 0 1px 3px rgba(37, 99, 235, 0.08);
}
.job-card:hover {
  border-color: #cbd5e1;
}
.job-card-top {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: 18px;
}
.job-name {
  font-size: 14px;
  font-weight: 650;
  color: #0f172a;
  line-height: 1.35;
}
.job-sub {
  font-size: 11px;
  color: #94a3b8;
  margin-top: -2px;
}
.job-type {
  font-size: 12px;
  color: #64748b;
  line-height: 1.35;
}
.job-sched {
  font-size: 12px;
  color: #475569;
  font-weight: 600;
}
.job-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid #f1f5f9;
}
@media (max-width: 960px) {
  .jobs-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .jobs-grid {
    grid-template-columns: 1fr;
  }
}
.link-btn {
  border: none;
  background: none;
  padding: 2px 0;
  font-size: 12px;
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
.modal-panel.log-modal {
  width: min(960px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
}
.modal-panel.detail-modal {
  width: min(860px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
}
.detail-mask {
  z-index: 10000;
}
.detail-modal-body {
  min-height: 0;
  padding: 12px 14px 16px;
}
.detail-pre {
  margin: 0;
  max-height: min(70vh, 640px);
  overflow: auto;
  padding: 12px;
  border-radius: 10px;
  background: #0f172a;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.log-table .col-act {
  width: 88px;
  white-space: nowrap;
  text-align: right;
}
.modal-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #64748b;
  font-weight: 500;
}
.modal-sub-type {
  margin-left: 8px;
  color: #94a3b8;
}
.log-modal-body {
  gap: 10px;
  min-height: 0;
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
.form-grid .span-full {
  grid-column: 1 / -1;
}
.interval-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.chip-btn {
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #64748b;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.chip-btn.active {
  color: #2563eb;
  background: #eff6ff;
  border-color: #93c5fd;
}
.field-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: #94a3b8;
  font-weight: 500;
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
.log-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.log-scroll {
  flex: 1;
  min-height: 240px;
  max-height: min(60vh, 520px);
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
  word-break: break-word;
  white-space: pre-wrap;
}
.tg-panel {
  margin-top: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}
.tg-summary {
  cursor: pointer;
  padding: 10px 12px;
  font-size: 0.82rem;
  font-weight: 700;
  color: #334155;
}
.tg-body { padding: 0 12px 12px; }
.tg-hint { margin: 0 0 10px; font-size: 0.76rem; line-height: 1.45; }
.tg-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.tg-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.76rem;
  color: #64748b;
}
.tg-grid input[type="text"],
.tg-grid input[type="password"] {
  padding: 6px 8px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.8rem;
}
.tg-actions { display: flex; gap: 8px; margin-top: 10px; }
@media (max-width: 720px) {
  .tg-grid { grid-template-columns: 1fr; }
}
</style>
