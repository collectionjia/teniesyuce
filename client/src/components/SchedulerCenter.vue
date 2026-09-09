<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import * as api from '../api'

const loading = ref(false)
const status = ref(null)
const jobs = ref([])
const jobTypes = ref([])
const nameOptions = ref({ collect: [], condition: [], betting: [] })
const selectedJobId = ref('')
const runs = ref([])
const msg = ref('')
const err = ref('')
const editDraft = ref({})

const form = ref({
  nameKey: '',
  jobType: 'collect.full',
  scheduleMode: 'interval',
  intervalSec: 60,
  dailyTime: '09:00',
  enabled: true,
})

const jobTypeOptions = computed(() => {
  if (jobTypes.value.length) return jobTypes.value
  return [
    { jobType: 'collect.full', label: '采集 · 全量拆三桶', category: 'collect' },
    { jobType: 'collect.inplay_tick', label: '采集 · 盘中 tick', category: 'collect' },
    { jobType: 'condition.query', label: '条件 · 查询筛选', category: 'condition' },
    { jobType: 'bet.scan', label: '投注 · 扫描下单', category: 'betting' },
  ]
})

function categoryOfJobType(jobType) {
  const t = jobTypeOptions.value.find((x) => x.jobType === jobType)
  if (t?.category) return t.category
  if (String(jobType).startsWith('collect')) return 'collect'
  if (String(jobType).startsWith('condition')) return 'condition'
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

function nameKeyFromJob(job) {
  const cat = categoryOfJobType(job.jobType)
  const p = job.params || {}
  if (cat === 'collect') return optionsForCategory('collect')[0]?.key || 'collect'
  if (p.bucket != null && p.groupIndex != null) {
    return `${cat}:${p.bucket}:${p.groupIndex}`
  }
  const hit = optionsForCategory(cat).find((o) => o.value === job.name || o.groupName === job.name)
  return hit?.key || ''
}

function draftFor(job) {
  if (!editDraft.value[job.id]) {
    editDraft.value[job.id] = {
      scheduleMode: job.scheduleMode || 'interval',
      intervalSec: job.intervalSec || 60,
      dailyTime: job.dailyTime || job.cronExpr || '09:00',
      nameKey: nameKeyFromJob(job),
    }
  }
  return editDraft.value[job.id]
}

watch(
  () => form.value.jobType,
  (jt) => {
    form.value.nameKey = pickDefaultNameKey(categoryOfJobType(jt))
  }
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
    nameOptions.value = j.nameOptions || { collect: [], condition: [], betting: [] }
    if (!form.value.nameKey) {
      form.value.nameKey = pickDefaultNameKey(categoryOfJobType(form.value.jobType))
    }
    editDraft.value = {}
    for (const job of jobs.value) draftFor(job)
    if (selectedJobId.value && !jobs.value.find((x) => x.id === selectedJobId.value)) {
      selectedJobId.value = jobs.value[0]?.id || ''
    }
    if (!selectedJobId.value && jobs.value[0]) {
      selectedJobId.value = jobs.value[0].id
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
    const data = await api.fetchSchedulerRuns(selectedJobId.value, { limit: 20 })
    runs.value = data.runs || []
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '日志加载失败'
  }
}

async function createJob() {
  msg.value = ''
  err.value = ''
  const cat = categoryOfJobType(form.value.jobType)
  const opt = optionByKey(cat, form.value.nameKey)
  if (!form.value.nameKey || !opt) {
    err.value = cat === 'collect'
      ? '请选择名称'
      : `请先在${cat === 'condition' ? '条件' : '投注'}引擎配置分组，再选择名称`
    return
  }
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
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
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

async function saveJob(job) {
  msg.value = ''
  const d = draftFor(job)
  const cat = categoryOfJobType(job.jobType)
  const opt = optionByKey(cat, d.nameKey)
  if (!d.nameKey || !opt) {
    err.value = '请选择名称'
    return
  }
  try {
    const payload = {
      name: opt.value,
      scheduleMode: d.scheduleMode,
      params: paramsFromOption(opt, cat),
    }
    if (d.scheduleMode === 'interval') payload.intervalSec = Number(d.intervalSec)
    else payload.dailyTime = d.dailyTime
    await api.patchSchedulerJob(job.id, payload)
    msg.value = `已保存：${opt.value}`
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
}

async function runNow(job) {
  msg.value = ''
  try {
    const r = await api.runSchedulerJob(job.id)
    msg.value = `立即执行：${job.name} · ${r.status || 'ok'} · ${r.runId || ''}`
    selectedJobId.value = job.id
    await loadRuns()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
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
  if (s === 'success') return 'text-emerald-600'
  if (s === 'failed' || s === 'timeout') return 'text-rose-600'
  if (s === 'skipped') return 'text-amber-600'
  if (s === 'running') return 'text-sky-600'
  return 'text-slate-500'
}

onMounted(refresh)
</script>

<template>
  <div class="space-y-4">
    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div>
          <div class="font-semibold">调度中心</div>
          <p class="text-xs text-slate-400 mt-0.5">
            名称：采集固定「采集」；条件/投注为引擎分组名（下拉选择）。
          </p>
        </div>
        <button
          type="button"
          class="text-sm px-3 py-1.5 rounded-xl border border-slate-200 text-slate-600"
          :disabled="loading"
          @click="refresh"
        >刷新</button>
      </div>
      <div v-if="status" class="text-xs text-slate-500">
        调度循环：
        <span :class="status.running ? 'text-emerald-600' : 'text-rose-600'">
          {{ status.running ? '运行中' : '未启动' }}
        </span>
        · 任务 {{ status.enabledCount }}/{{ status.jobCount }} 启用
      </div>
      <p v-if="msg" class="text-xs text-emerald-600">{{ msg }}</p>
      <p v-if="err" class="text-xs text-rose-600">{{ err }}</p>
    </div>

    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
      <div class="font-semibold text-sm">新增任务</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <div class="text-xs text-slate-400 mb-1">目标类型</div>
          <select v-model="form.jobType" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm">
            <option v-for="t in jobTypeOptions" :key="t.jobType" :value="t.jobType">{{ t.label }}</option>
          </select>
        </div>
        <div>
          <div class="text-xs text-slate-400 mb-1">名称</div>
          <select
            v-model="form.nameKey"
            class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
            :disabled="!formNameOptions.length"
          >
            <option value="" disabled>
              {{ formNameOptions.length ? '请选择' : '暂无分组（请先在条件/投注引擎配置）' }}
            </option>
            <option v-for="o in formNameOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </div>
        <div>
          <div class="text-xs text-slate-400 mb-1">时间方式</div>
          <select v-model="form.scheduleMode" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm">
            <option value="interval">每隔 N 秒</option>
            <option value="daily">每天定点（北京时间）</option>
          </select>
        </div>
        <div v-if="form.scheduleMode === 'interval'">
          <div class="text-xs text-slate-400 mb-1">间隔（秒）</div>
          <input v-model.number="form.intervalSec" type="number" min="1" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </div>
        <div v-else>
          <div class="text-xs text-slate-400 mb-1">每天时刻 HH:mm</div>
          <input v-model="form.dailyTime" type="time" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm" />
        </div>
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-600">
        <input v-model="form.enabled" type="checkbox" class="rounded" />
        创建后立即启用
      </label>
      <button
        type="button"
        class="w-full sm:w-auto px-4 py-2 rounded-xl bg-primary-600 text-white text-sm"
        @click="createJob"
      >新增任务</button>
    </div>

    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
      <div class="font-semibold text-sm">任务列表</div>
      <div v-if="!jobs.length" class="text-xs text-slate-400">暂无任务</div>
      <div
        v-for="job in jobs"
        :key="job.id"
        class="border border-slate-100 rounded-xl p-3 space-y-2"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div class="text-sm font-medium">{{ job.name }}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">
              {{ job.jobTypeLabel || job.jobType }}
              · {{ scheduleText(job) }}
              <span v-if="job.params?.bucket"> · {{ job.params.bucket }}#{{ job.params.groupIndex }}</span>
            </div>
          </div>
          <span
            class="text-[11px] px-2 py-0.5 rounded-full"
            :class="job.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'"
          >{{ job.enabled ? '启用' : '停用' }}</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <div class="text-[11px] text-slate-400 mb-0.5">名称</div>
            <select
              v-model="draftFor(job).nameKey"
              class="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm"
            >
              <option
                v-for="o in optionsForCategory(categoryOfJobType(job.jobType))"
                :key="o.key"
                :value="o.key"
              >{{ o.label }}</option>
            </select>
          </div>
          <div>
            <div class="text-[11px] text-slate-400 mb-0.5">时间方式</div>
            <select v-model="draftFor(job).scheduleMode" class="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm">
              <option value="interval">每隔 N 秒</option>
              <option value="daily">每天定点</option>
            </select>
          </div>
          <div v-if="draftFor(job).scheduleMode === 'interval'">
            <div class="text-[11px] text-slate-400 mb-0.5">间隔（秒）</div>
            <input v-model.number="draftFor(job).intervalSec" type="number" min="1" class="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm" />
          </div>
          <div v-else>
            <div class="text-[11px] text-slate-400 mb-0.5">每天 HH:mm</div>
            <input v-model="draftFor(job).dailyTime" type="time" class="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm" />
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="text-xs px-2.5 py-1 rounded-lg border border-slate-200" @click="saveJob(job)">保存</button>
          <button type="button" class="text-xs px-2.5 py-1 rounded-lg border border-slate-200" @click="toggleJob(job, !job.enabled)">
            {{ job.enabled ? '停用' : '启用' }}
          </button>
          <button type="button" class="text-xs px-2.5 py-1 rounded-lg bg-primary-600 text-white" @click="runNow(job)">立即执行</button>
          <button type="button" class="text-xs px-2.5 py-1 rounded-lg border border-slate-200" @click="selectedJobId = job.id; loadRuns()">看日志</button>
          <button type="button" class="text-xs px-2.5 py-1 rounded-lg text-rose-600 border border-rose-100" @click="removeJob(job)">删除</button>
        </div>
      </div>
    </div>

    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-2">
      <div class="flex items-center justify-between">
        <div class="font-semibold text-sm">运行日志</div>
        <select
          v-model="selectedJobId"
          class="text-xs border border-slate-200 rounded-lg px-2 py-1"
          @change="loadRuns"
        >
          <option value="">选择任务</option>
          <option v-for="j in jobs" :key="j.id" :value="j.id">{{ j.name }}</option>
        </select>
      </div>
      <div v-if="!runs.length" class="text-xs text-slate-400">暂无记录</div>
      <div class="overflow-x-auto">
        <table v-if="runs.length" class="w-full text-xs text-left">
          <thead class="text-slate-400">
            <tr>
              <th class="py-1 pr-2">时间</th>
              <th class="py-1 pr-2">触发</th>
              <th class="py-1 pr-2">状态</th>
              <th class="py-1">说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.runId" class="border-t border-slate-50">
              <td class="py-1.5 pr-2 whitespace-nowrap">{{ r.startedAt }}</td>
              <td class="py-1.5 pr-2">{{ r.trigger }}</td>
              <td class="py-1.5 pr-2" :class="statusClass(r.status)">{{ r.status }}</td>
              <td class="py-1.5 text-slate-500 truncate max-w-[220px]" :title="r.error || r.message">
                {{ r.error || r.message || r.runId }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
