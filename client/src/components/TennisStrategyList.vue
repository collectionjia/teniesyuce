<script setup>
import { computed, ref, watch } from 'vue'
import * as api from '../api'
import { normalizeInplayBettingEntry } from '../utils/tennisListFilters'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['update:open', 'changed', 'edit'])

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const creating = ref(false)
const newName = ref('')
const renamingId = ref('')
const renameDraft = ref('')

const logsOpen = ref(false)
const logsLoading = ref(false)
const logsError = ref('')
const logs = ref([])
const logsFilter = ref('all') // all | buy | stop | run
const logsTotal = ref(0)

/** 勾选的策略 key */
const selectedKeys = ref(new Set())
/** 已开启自动投注的策略 key（来自调度任务） */
const autoBetKeys = ref(new Set())
const autoBetting = ref(false)

async function openLogs() {
  logsOpen.value = true
  await loadLogs()
}

async function loadLogs({ soft = false } = {}) {
  if (logsLoading.value) return
  logsLoading.value = true
  if (!soft) logsError.value = ''
  try {
    const params = { limit: 300 }
    if (logsFilter.value !== 'all') params.type = logsFilter.value
    const data = await api.fetchTennisBettingExecLogs(params)
    logs.value = Array.isArray(data?.items) ? data.items : []
    logsTotal.value = Number(data?.total) || logs.value.length
    logsError.value = ''
  } catch (e) {
    logsError.value = e?.response?.data?.error || e?.message || '加载日志失败'
    if (!soft) logs.value = []
  } finally {
    logsLoading.value = false
  }
}

async function clearLogs() {
  if (!confirm('确认清空全部调度执行日志？')) return
  try {
    await api.clearTennisBettingExecLogs()
    await loadLogs({ soft: true })
  } catch (e) {
    logsError.value = e?.response?.data?.error || e?.message || '清空失败'
  }
}

function fmtAt(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function typeLabel(row) {
  if (row.type === 'run') return '扫描'
  if (row.type === 'buy') return '条件'
  if (row.type === 'stop') return '止损'
  return row.type || '—'
}

function metLabel(row) {
  if (row.type === 'run') return '—'
  if (row.met === true) return '满足'
  if (row.met === false) return '不满足'
  return '—'
}

function moneyTxt(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return `$${n}`
}

function priceTxt(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return String(n)
}

function bucketLabel(b) {
  if (b === 'prematch') return '开赛前'
  if (b === 'inplay') return '比赛中'
  return b || '—'
}

function emptyCond(name = '', strategyKey = '') {
  const id = `cg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    strategyKey: strategyKey || id,
    name: String(name || '').trim().slice(0, 40),
    joinPrev: 'or',
    tour: 'all',
    pm: 'all',
    gapMin: 'all',
    rankDiffMin: 'all',
    rankDiffMax: 'all',
    strongRankMax: 'all',
    strongRankGt: 'all',
    strongRankLt: 'all',
    gapMode: 'all',
    requireWonFirstSet: false,
    firstSetExcludeEnabled: false,
    firstSetExcludeScore: '7:5',
    checkIntervalSec: 60,
  }
}

function emptyBet(name = '', amount = 1, strategyKey = '') {
  const id = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    strategyKey: strategyKey || id,
    name: String(name || '').trim().slice(0, 40),
    joinPrev: 'or',
    amountUsd: Number(amount) >= 1 ? Number(amount) : 1,
    stopEnabled: true,
    stopRules: [{
      name: '',
      joinPrev: 'or',
      stopFormat: 'any',
      stopSetIndex: 'all',
      stopStrongSets: 'all',
      stopWeakSets: 'all',
      stopGameLead: 'all',
      stopWeakGamesMin: 'all',
      stopPmCentsMax: 'all',
    }],
    stopIntervalSec: 60,
  }
}

const buckets = ref({
  prematch: { condOn: false, groups: [], betOn: false, simulate: false, betGroups: [], entry: null },
  inplay: { condOn: false, groups: [], betOn: false, simulate: false, betGroups: [], entry: null },
})

function groupKey(g, i) {
  // 仅按 strategyKey 合并开赛前/比赛中；无 key 时用 id；再无则用名称
  const sk = String(g?.strategyKey || '').trim()
  if (sk) return sk
  const id = String(g?.id || '').trim()
  if (id) return id
  const name = String(g?.name || '').trim()
  if (name) return `name:${name}`
  return `idx_${i}`
}

function normalizeLoadedGroup(emptyFactory, g) {
  const raw = g && typeof g === 'object' ? g : {}
  const base = emptyFactory()
  const merged = { ...base, ...raw }
  // 禁止用 empty*() 新生成的 id/strategyKey 污染已有组
  // （否则每次 load 开赛前/比赛中各拿到不同 key，列表会「多一条」）
  merged.id = String(raw.id || '').trim() || base.id
  const sk = String(raw.strategyKey || '').trim()
  merged.strategyKey = sk || merged.id
  if (raw.name != null) merged.name = raw.name
  return merged
}

/** 统一策略列表：同 strategyKey / 同名 合并为一行 */
const list = computed(() => {
  const map = new Map()
  const nameToKey = new Map()
  for (const bucket of ['prematch', 'inplay']) {
    const groups = buckets.value[bucket]?.groups || []
    groups.forEach((g, i) => {
      let sk = groupKey(g, i)
      const name = String(g.name || '').trim() || '未命名策略'
      const rawName = String(g.name || '').trim()
      if (rawName && nameToKey.has(rawName)) {
        sk = nameToKey.get(rawName)
      } else if (rawName) {
        nameToKey.set(rawName, sk)
      }
      const cur = map.get(sk) || {
        key: sk,
        id: String(g.id || sk),
        name,
        rawName,
        prematchIndex: -1,
        inplayIndex: -1,
        conditionIntervalSec: 60,
        stopIntervalSec: 60,
      }
      if (bucket === 'prematch') cur.prematchIndex = i
      else cur.inplayIndex = i
      const cis = Number(g.checkIntervalSec)
      if (Number.isFinite(cis) && cis >= 10) cur.conditionIntervalSec = Math.min(600, Math.round(cis))
      if (name && name !== '未命名策略') {
        cur.name = name
        cur.rawName = name
      }
      if (!cur.id && g.id) cur.id = String(g.id)
      map.set(sk, cur)
    })
  }
  // 补止损间隔（来自投注组）
  for (const bucket of ['prematch', 'inplay']) {
    const betGroups = buckets.value[bucket]?.betGroups || []
    betGroups.forEach((g) => {
      const sk = String(g?.strategyKey || '').trim() || String(g?.id || '').trim()
      if (!sk || !map.has(sk)) return
      const cur = map.get(sk)
      const sis = Number(g.stopIntervalSec)
      if (Number.isFinite(sis) && sis >= 10) cur.stopIntervalSec = Math.min(600, Math.round(sis))
    })
  }
  return [...map.values()].map((item) => ({
    ...item,
    autoOn: autoBetKeys.value.has(item.key),
    checked: selectedKeys.value.has(item.key),
  }))
})

const selectedCount = computed(() => selectedKeys.value.size)

function isChecked(key) {
  return selectedKeys.value.has(String(key))
}

function toggleCheck(item) {
  const key = String(item.key)
  const next = new Set(selectedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedKeys.value = next
}

function toggleCheckAll() {
  if (selectedKeys.value.size === list.value.length) {
    selectedKeys.value = new Set()
    return
  }
  selectedKeys.value = new Set(list.value.map((x) => x.key))
}

function clampPollSec(raw, fallback = 60) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(600, Math.max(10, Math.round(n)))
}

function safeJobKey(strategyKey) {
  return String(strategyKey || 'x').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40) || 'x'
}

async function refreshAutoBetStatus() {
  try {
    const data = await api.fetchSchedulerJobs()
    const jobs = Array.isArray(data?.jobs) ? data.jobs : []
    const on = new Set()
    for (const j of jobs) {
      if (!j?.enabled) continue
      const p = j.params || {}
      const id = String(j.id || '')
      const jt = String(j.jobType || '')
      const isBet = jt === 'bet.scan' || id.includes('stbuy') || id.includes('ststop') || id.includes('bet_scan')
      if (!isBet) continue
      const sk = String(p.strategyKey || '').trim()
      if (sk) on.add(sk)
    }
    autoBetKeys.value = on
  } catch {
    /* ignore */
  }
}

async function upsertScheduleJob({ id, name, jobType, intervalSec, enabled, params }, existingJobs) {
  const body = {
    name,
    scheduleMode: 'interval',
    intervalSec: clampPollSec(intervalSec, 60),
    enabled: !!enabled,
    params,
  }
  const listJobs = Array.isArray(existingJobs) ? existingJobs : []
  const matches = listJobs.filter((j) => {
    if (!j) return false
    if (id && j.id === id) return true
    const p = j.params || {}
    if (String(p.strategyKey || '') !== String(params?.strategyKey || '')) return false
    if (String(p.bucket || '') !== String(params?.bucket || '')) return false
    const pm = String(p.mode || '')
    const wm = String(params?.mode || '')
    if (pm && wm && pm !== wm) return false
    return true
  })
  if (matches.length) {
    await Promise.all(matches.map((j) => api.patchSchedulerJob(j.id, body)))
    return matches[0].id
  }
  await api.createSchedulerJob({ id, jobType, ...body })
  return id
}

/** 勾选策略 → 开启自动投注：按条件间隔筛选下单，按止损间隔刷新止损 */
async function startAutoBetSelected() {
  const items = list.value.filter((x) => selectedKeys.value.has(x.key))
  if (!items.length) {
    error.value = '请先勾选要自动投注的策略'
    return
  }
  if (autoBetting.value) return
  autoBetting.value = true
  error.value = ''
  notice.value = ''
  try {
    const cfg = await api.fetchTennisEngines()
    const condBuckets = { ...(cfg?.condition?.buckets || {}) }
    const betBuckets = { ...(cfg?.betting?.buckets || {}) }
    const selectedSet = new Set(items.map((x) => x.key))

    for (const bucket of ['prematch', 'inplay']) {
      const c = { ...(condBuckets[bucket] || {}), groups: [...(condBuckets[bucket]?.groups || [])] }
      const b = { ...(betBuckets[bucket] || {}), groups: [...(betBuckets[bucket]?.groups || [])] }
      let touch = false
      const hit = (g) => {
        const sk = String(g?.strategyKey || '').trim() || String(g?.id || '').trim()
        const nm = String(g?.name || '').trim()
        if (selectedSet.has(sk)) return true
        return items.some((it) => it.rawName && nm && it.rawName === nm)
      }
      c.groups = c.groups.map((g) => {
        if (!hit(g)) return g
        touch = true
        return { ...g, autoSelectFromCollect: true }
      })
      b.groups = b.groups.map((g) => {
        if (!hit(g)) return g
        touch = true
        return { ...g, autoSelectFromCollect: true }
      })
      if (touch) {
        c.enabled = true
        b.enabled = true
      }
      condBuckets[bucket] = c
      betBuckets[bucket] = b
    }

    await api.updateTennisEngines({
      condition: { enabled: true, buckets: condBuckets },
      betting: { enabled: true, buckets: betBuckets },
    })

    let existingJobs = []
    try {
      const data = await api.fetchSchedulerJobs()
      existingJobs = Array.isArray(data?.jobs) ? data.jobs : []
    } catch {
      existingJobs = []
    }

    const runIds = []
    for (const item of items) {
      const sk = item.key
      const safe = safeJobKey(sk)
      const label = String(item.name || sk).slice(0, 40)
      const condSec = clampPollSec(item.conditionIntervalSec, 60)
      const stopSec = clampPollSec(item.stopIntervalSec, 60)
      for (const bucket of ['prematch', 'inplay']) {
        const matchG = (g) => {
          const k = String(g?.strategyKey || '').trim() || String(g?.id || '').trim()
          const nm = String(g?.name || '').trim()
          return k === sk || (item.rawName && nm === item.rawName)
        }
        const hasCond = (buckets.value[bucket]?.groups || []).some(matchG)
        const hasBet = (buckets.value[bucket]?.betGroups || []).some(matchG)
        if (!hasCond && !hasBet) continue
        const tag = bucket === 'inplay' ? '比赛中' : '开赛前'
        if (hasCond) {
          const buyId = await upsertScheduleJob({
            id: `job_stbuy_${safe}_${bucket}`,
            name: `${label}·${tag}·条件投注`,
            jobType: 'bet.scan',
            intervalSec: condSec,
            enabled: true,
            params: { strategyKey: sk, bucket, mode: 'buy' },
          }, existingJobs)
          runIds.push(buyId)
        }
        if (hasBet) {
          const stopId = await upsertScheduleJob({
            id: `job_ststop_${safe}_${bucket}`,
            name: `${label}·${tag}·止损`,
            jobType: 'bet.scan',
            intervalSec: stopSec,
            enabled: true,
            params: { strategyKey: sk, bucket, mode: 'stop' },
          }, existingJobs)
          runIds.push(stopId)
        }
      }
    }

    // 立刻跑一轮：条件筛选下单 + 止损检查
    for (const id of [...new Set(runIds)]) {
      try {
        await api.runSchedulerJob(id)
      } catch { /* 单次失败不阻断 */ }
    }

    await refreshAutoBetStatus()
    await load({ soft: true })
    emit('changed')
    notice.value = `已开启自动投注（${items.length} 个策略）：按条件间隔筛选下单，按止损间隔刷新止损`
    setTimeout(() => { notice.value = '' }, 3200)
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '开启自动投注失败'
  } finally {
    autoBetting.value = false
  }
}

function jobMatchesStrategy(j, item) {
  if (!j || !item) return false
  const p = j.params || {}
  const sk = String(p.strategyKey || '').trim()
  const key = String(item.key || '').trim()
  const raw = String(item.rawName || '').trim()
  if (sk && (sk === key || (raw && sk === raw))) return true
  const id = String(j.id || '')
  const safe = safeJobKey(key)
  if (safe && (id.includes(`stbuy_${safe}_`) || id.includes(`ststop_${safe}_`))) return true
  return false
}

async function disableJobQuiet(id) {
  if (!id) return
  try {
    await api.disableSchedulerJob(id)
  } catch {
    try {
      await api.patchSchedulerJob(id, { enabled: false })
    } catch { /* ignore */ }
  }
}

/** 停止勾选策略的自动投注调度 */
async function stopAutoBetSelected() {
  const items = list.value.filter((x) => selectedKeys.value.has(x.key))
  if (!items.length) {
    error.value = '请先勾选要停止的策略'
    return
  }
  if (autoBetting.value) return
  autoBetting.value = true
  error.value = ''
  notice.value = ''
  try {
    let jobs = []
    try {
      const data = await api.fetchSchedulerJobs()
      jobs = Array.isArray(data?.jobs) ? data.jobs : []
    } catch {
      jobs = []
    }

    const disabledIds = new Set()
    for (const item of items) {
      // 1) 按真实任务列表匹配（创建时可能复用了别的 id，不能只拼 job_stbuy_xxx）
      for (const j of jobs) {
        const jt = String(j?.jobType || '')
        const id = String(j?.id || '')
        const isBetScan = jt === 'bet.scan' || id.includes('stbuy') || id.includes('ststop') || id.includes('bet_scan')
        if (!isBetScan || !jobMatchesStrategy(j, item)) continue
        if (disabledIds.has(id)) continue
        disabledIds.add(id)
        await disableJobQuiet(id)
      }
      // 2) 再尝试规范 id（兼容旧任务）
      const safe = safeJobKey(item.key)
      for (const bucket of ['prematch', 'inplay']) {
        for (const kind of ['stbuy', 'ststop']) {
          const id = `job_${kind}_${safe}_${bucket}`
          if (disabledIds.has(id)) continue
          disabledIds.add(id)
          await disableJobQuiet(id)
        }
      }
    }

    // 若已无启用中的 bet.scan，关掉桶级投注开关，避免漏关任务仍买入
    try {
      const data2 = await api.fetchSchedulerJobs().catch(() => null)
      const left = (Array.isArray(data2?.jobs) ? data2.jobs : []).filter((j) => {
        if (!j?.enabled) return false
        const id = String(j.id || '')
        const jt = String(j.jobType || '')
        return jt === 'bet.scan' || id.includes('stbuy') || id.includes('ststop') || id.includes('bet_scan')
      })
      if (!left.length) {
        const cfg = await api.fetchTennisEngines()
        const betBuckets = { ...(cfg?.betting?.buckets || {}) }
        let touched = false
        for (const bucket of ['prematch', 'inplay']) {
          const prev = betBuckets[bucket] || {}
          if (prev.enabled) {
            betBuckets[bucket] = { ...prev, enabled: false }
            touched = true
          }
        }
        if (touched) {
          await api.updateTennisEngines({
            betting: { ...(cfg?.betting || {}), enabled: true, buckets: betBuckets },
          })
        }
      }
    } catch { /* 调度已关则忽略 */ }

    await refreshAutoBetStatus()
    notice.value = `已停止自动投注（${items.length} 个策略）`
    setTimeout(() => { notice.value = '' }, 2500)
    emit('changed')
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '停止失败'
  } finally {
    autoBetting.value = false
  }
}

async function load({ soft = false } = {}) {
  if (loading.value) return
  loading.value = true
  if (!soft) error.value = ''
  try {
    const cfg = await api.fetchTennisEngines()
    const cond = cfg?.condition?.buckets || {}
    const bet = cfg?.betting?.buckets || {}
    const build = (key) => {
      const c = cond[key] || {}
      const b = bet[key] || {}
      return {
        condOn: !!c.enabled,
        groups: Array.isArray(c.groups) ? c.groups.map((g) => normalizeLoadedGroup(emptyCond, g)) : [],
        betOn: !!b.enabled,
        simulate: !!b.simulate,
        betGroups: Array.isArray(b.groups) ? b.groups.map((g) => normalizeLoadedGroup(() => emptyBet(), g)) : [],
        entry: key === 'inplay' ? normalizeInplayBettingEntry(b.entry) : null,
      }
    }
    buckets.value = {
      prematch: build('prematch'),
      inplay: build('inplay'),
    }
    error.value = ''
    await refreshAutoBetStatus()
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function refreshList() {
  await load({ soft: true })
}

watch(() => props.open, (v) => {
  if (v) {
    creating.value = false
    newName.value = ''
    renamingId.value = ''
    // 已有列表时后台软刷新，不闪整框
    load({ soft: list.value.length > 0 })
  }
})

async function persist() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const pm = buckets.value.prematch
    const ip = buckets.value.inplay
    await api.updateTennisEngines({
      condition: {
        enabled: true,
        buckets: {
          prematch: { enabled: !!pm.condOn || pm.groups.length > 0, groups: pm.groups },
          inplay: { enabled: !!ip.condOn || ip.groups.length > 0, groups: ip.groups },
        },
      },
      betting: {
        enabled: true,
        buckets: {
          prematch: {
            enabled: !!pm.betOn,
            simulate: !!pm.simulate,
            groups: pm.betGroups.length ? pm.betGroups : [emptyBet()],
          },
          inplay: {
            enabled: !!ip.betOn,
            simulate: !!ip.simulate,
            entry: normalizeInplayBettingEntry(ip.entry),
            groups: ip.betGroups.length ? ip.betGroups : [emptyBet()],
          },
        },
      },
    })
    notice.value = '已保存'
    emit('changed')
    setTimeout(() => { notice.value = '' }, 1600)
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

function startCreate() {
  creating.value = true
  newName.value = ''
  error.value = ''
}

function cancelCreate() {
  creating.value = false
  newName.value = ''
}

async function confirmCreate() {
  const name = String(newName.value || '').trim().slice(0, 40)
  if (!name) {
    error.value = '请先填写策略名称'
    return
  }
  if (list.value.some((x) => x.rawName === name || x.name === name)) {
    error.value = '已存在同名策略'
    return
  }
  const strategyKey = `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const pmCond = emptyCond(name, strategyKey)
  const next = { ...buckets.value }
  for (const bucket of ['prematch', 'inplay']) {
    const b = { ...next[bucket] }
    const cond = bucket === 'prematch' ? pmCond : emptyCond(name, strategyKey)
    b.groups = [...(b.groups || []), cond]
    b.betGroups = [...(b.betGroups || []), emptyBet(name, 1, strategyKey)]
    b.condOn = true
    next[bucket] = b
  }
  buckets.value = next
  creating.value = false
  newName.value = ''
  await persist()
  // 进入该策略独立设置页，不与其它策略混编
  emit('edit', {
    bucket: 'prematch',
    id: pmCond.id,
    name,
    strategyKey,
  })
  emit('update:open', false)
}

function startRename(item) {
  renamingId.value = item.key
  renameDraft.value = item.rawName || item.name
}

function cancelRename() {
  renamingId.value = ''
  renameDraft.value = ''
}

function renameInBucket(bucket, index, name, strategyKey) {
  if (index < 0) return
  const b = { ...buckets.value[bucket] }
  const groups = [...(b.groups || [])]
  if (!groups[index]) return
  groups[index] = { ...groups[index], name, strategyKey: strategyKey || groups[index].strategyKey }
  const betGroups = [...(b.betGroups || [])]
  if (betGroups[index]) {
    betGroups[index] = { ...betGroups[index], name, strategyKey: strategyKey || betGroups[index].strategyKey }
  }
  b.groups = groups
  b.betGroups = betGroups
  buckets.value = { ...buckets.value, [bucket]: b }
}

async function confirmRename(item) {
  const name = String(renameDraft.value || '').trim().slice(0, 40)
  if (!name) {
    error.value = '名称不能为空'
    return
  }
  renameInBucket('prematch', item.prematchIndex, name, item.key)
  renameInBucket('inplay', item.inplayIndex, name, item.key)
  renamingId.value = ''
  renameDraft.value = ''
  await persist()
}

function removeInBucket(bucket, index) {
  if (index < 0) return
  const b = { ...buckets.value[bucket] }
  b.groups = (b.groups || []).filter((_, i) => i !== index)
  if ((b.betGroups || []).length > index) {
    b.betGroups = b.betGroups.filter((_, i) => i !== index)
  }
  buckets.value = { ...buckets.value, [bucket]: b }
}

async function removeItem(item) {
  if (!window.confirm(`删除策略「${item.name}」？`)) return
  const ops = [
    ['prematch', item.prematchIndex],
    ['inplay', item.inplayIndex],
  ].filter(([, idx]) => idx >= 0).sort((a, b) => b[1] - a[1])
  for (const [bucket, idx] of ops) removeInBucket(bucket, idx)
  await persist()
  // 与「停止自动」同一套匹配：关掉/删掉残留调度，避免删策略后还在扫
  try {
    const data = await api.fetchSchedulerJobs()
    const jobs = Array.isArray(data?.jobs) ? data.jobs : []
    for (const j of jobs) {
      if (!jobMatchesStrategy(j, item)) continue
      const id = String(j.id || '')
      try {
        await api.disableSchedulerJob(id)
      } catch {
        try { await api.patchSchedulerJob(id, { enabled: false }) } catch { /* ignore */ }
      }
      try {
        await api.deleteSchedulerJob(id)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  const sk = String(item.key || item.strategyKey || '').trim()
  if (sk) {
    const safe = safeJobKey(sk)
    for (const bucket of ['prematch', 'inplay']) {
      for (const kind of ['stbuy', 'ststop']) {
        try {
          await api.deleteSchedulerJob(`job_${kind}_${safe}_${bucket}`)
        } catch { /* 无任务则忽略 */ }
      }
    }
  }
  await refreshAutoBetStatus()
}

function editItem(item) {
  emit('edit', {
    bucket: item.prematchIndex >= 0 ? 'prematch' : 'inplay',
    id: item.id,
    name: item.name,
    strategyKey: item.key,
  })
  emit('update:open', false)
}

function close() {
  emit('update:open', false)
}
</script>

<template>
  <div v-if="open" class="sl-mask" @click.self="close">
    <aside class="sl-panel" role="dialog" aria-modal="true">
      <header class="sl-head">
        <div>
          <div class="sl-title">策略列表</div>
          <div class="sl-sub">勾选策略后点「自动投注」：按条件间隔筛选下单，按止损间隔检查止损</div>
        </div>
        <button type="button" class="sl-x" @click="close">×</button>
      </header>

      <p v-if="error" class="msg err">{{ error }}</p>
      <p v-if="notice" class="msg ok">{{ notice }}</p>

      <div class="sl-actions">
        <button type="button" class="btn primary" :disabled="saving" @click="startCreate">新建策略</button>
        <button type="button" class="btn ghost" :disabled="loading" @click="refreshList">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
        <button type="button" class="btn ghost" @click="openLogs">调度执行日志</button>
      </div>

      <div v-if="creating" class="create-box">
        <div class="create-h">新建策略</div>
        <input
          v-model="newName"
          class="name-input"
          type="text"
          maxlength="40"
          placeholder="请输入策略名称"
          @keyup.enter="confirmCreate"
        />
        <div class="create-btns">
          <button type="button" class="btn primary" :disabled="saving" @click="confirmCreate">确定</button>
          <button type="button" class="btn ghost" @click="cancelCreate">取消</button>
        </div>
      </div>

      <section class="sl-sec">
        <div class="sl-sec-toolbar">
          <h3>
            全部策略 <span>{{ list.length }}</span>
            <span v-if="loading && list.length" class="soft-tip">更新中…</span>
          </h3>
          <div class="sl-sec-actions">
            <button type="button" class="btn ghost" :disabled="!list.length" @click="toggleCheckAll">
              {{ selectedCount === list.length && list.length ? '取消全选' : '全选' }}
            </button>
            <button
              type="button"
              class="btn primary"
              :disabled="autoBetting || saving || !selectedCount"
              @click="startAutoBetSelected"
            >{{ autoBetting ? '处理中…' : '自动投注' }}</button>
            <button
              type="button"
              class="btn ghost"
              :disabled="autoBetting || saving || !selectedCount"
              @click="stopAutoBetSelected"
            >停止自动</button>
          </div>
        </div>
        <div class="sl-sec-hint">已勾选 {{ selectedCount }} · 自动投注中 {{ autoBetKeys.size }}</div>
        <div v-if="loading && !list.length" class="empty">加载中…</div>
        <div v-else-if="!list.length" class="empty">暂无策略，点上方新建</div>
        <div v-for="item in list" :key="item.key" class="row" :class="{ auto: item.autoOn }">
          <template v-if="renamingId === item.key">
            <input v-model="renameDraft" class="name-input grow" maxlength="40" @keyup.enter="confirmRename(item)" />
            <button type="button" class="mini primary" :disabled="saving" @click="confirmRename(item)">存</button>
            <button type="button" class="mini" @click="cancelRename">取消</button>
          </template>
          <template v-else>
            <label class="chk" @click.stop>
              <input type="checkbox" :checked="isChecked(item.key)" @change="toggleCheck(item)" />
            </label>
            <button type="button" class="name-btn" @click="editItem(item)">{{ item.name }}</button>
            <span v-if="item.autoOn" class="auto-tag">自动中</span>
            <span class="iv-tag" :title="'条件间隔 / 止损间隔'">{{ item.conditionIntervalSec }}s / {{ item.stopIntervalSec }}s</span>
            <button type="button" class="mini" :disabled="saving" @click="startRename(item)">改名</button>
            <button type="button" class="mini danger" :disabled="saving" @click="removeItem(item)">删</button>
          </template>
        </div>
      </section>
    </aside>

    <div v-if="logsOpen" class="log-mask" @click.self="logsOpen = false">
      <div class="log-panel" role="dialog" aria-modal="true" aria-label="调度执行日志">
        <header class="log-head">
          <div>
            <div class="log-title">调度执行日志</div>
            <div class="log-sub">条件筛选与止损执行明细（最近 {{ logsTotal }} 条）</div>
          </div>
          <button type="button" class="sl-x" @click="logsOpen = false">×</button>
        </header>
        <div class="log-toolbar">
          <select v-model="logsFilter" @change="loadLogs">
            <option value="all">全部</option>
            <option value="run">扫描汇总</option>
            <option value="buy">条件/买入</option>
            <option value="stop">止损/卖出</option>
          </select>
          <button type="button" class="btn ghost" :disabled="logsLoading" @click="loadLogs({ soft: true })">
            {{ logsLoading ? '刷新中…' : '刷新' }}
          </button>
          <button type="button" class="btn danger" :disabled="logsLoading" @click="clearLogs">清空</button>
        </div>
        <p v-if="logsError" class="msg err">{{ logsError }}</p>
        <div v-if="logsLoading && !logs.length" class="empty">加载中…</div>
        <div v-else-if="!logs.length" class="empty">暂无执行日志。调度跑过条件/止损后会出现在这里。</div>
        <div v-else class="log-list">
          <div v-if="logsLoading" class="soft-tip pad">后台更新中…</div>
          <article
            v-for="row in logs"
            :key="row.id"
            class="log-row"
            :class="{
              run: row.type === 'run',
              met: row.met === true,
              miss: row.met === false,
              fail: row.ok === false,
            }"
          >
            <div class="log-top">
              <span class="t">{{ fmtAt(row.at) }}</span>
              <span class="chip">{{ typeLabel(row) }}</span>
              <span class="chip">{{ bucketLabel(row.bucket) }}</span>
              <span v-if="row.simulated" class="chip sim">模拟</span>
              <span class="chip" :class="{ ok: row.met === true, no: row.met === false }">{{ metLabel(row) }}</span>
            </div>
            <div v-if="row.match" class="log-match">{{ row.match }}</div>
            <div class="log-detail">{{ row.detail || '—' }}</div>
            <div v-if="row.type !== 'run'" class="log-meta">
              <span v-if="row.action === 'buy'">买入 {{ moneyTxt(row.amountUsd) }} · 价 {{ priceTxt(row.price) }}</span>
              <span v-else-if="row.action === 'sell'">卖出 · 价 {{ priceTxt(row.price) }} <template v-if="row.amountUsd != null">· {{ moneyTxt(row.amountUsd) }}</template></span>
              <span v-else-if="row.met === false">未成交</span>
              <span v-if="row.error" class="err-txt">{{ row.error }}</span>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sl-mask {
  position: fixed;
  inset: 0;
  z-index: 85;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
}
.sl-panel {
  width: min(620px, 100%);
  height: 100%;
  background: #f8fafc;
  border-left: 1px solid #cbd5e1;
  box-shadow: -12px 0 40px rgba(15, 23, 42, 0.18);
  padding: 14px 14px 20px;
  overflow: auto;
}
.sl-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.sl-title { font-size: 17px; font-weight: 800; color: #0f172a; }
.sl-sub { margin-top: 4px; font-size: 12px; color: #64748b; }
.sl-x {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: #e2e8f0;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.msg { font-size: 12px; margin: 0 0 8px; }
.msg.err { color: #b91c1c; }
.msg.ok { color: #047857; }
.soft-tip {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 500;
  color: #64748b;
}
.soft-tip.pad {
  margin: 0 0 8px;
  margin-left: 0;
}
.sl-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.btn {
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid #94a3b8;
  background: #fff;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
.btn.primary { background: #0f172a; border-color: #0f172a; color: #fff; }
.btn.ghost { background: #e2e8f0; }
.btn.danger { border-color: #fca5a5; background: #fee2e2; color: #b91c1c; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.create-box {
  margin-bottom: 12px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid #bae6fd;
  background: #f0f9ff;
}
.create-h { font-size: 12px; font-weight: 700; color: #0369a1; margin-bottom: 8px; }
.name-input {
  width: 100%;
  height: 34px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0 10px;
  font-size: 13px;
  background: #fff;
  box-sizing: border-box;
}
.name-input.grow { flex: 1; min-width: 0; }
.create-btns { display: flex; gap: 8px; margin-top: 8px; }
.sl-sec {
  margin-bottom: 14px;
  padding: 10px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}
.sl-sec-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.sl-sec-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sl-sec-hint {
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 6px;
}
.sl-sec h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 800;
  color: #334155;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sl-sec h3 span {
  font-size: 11px;
  font-weight: 600;
  color: #0284c7;
}
.empty { font-size: 12px; color: #94a3b8; padding: 6px 0; }
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  border-top: 1px solid #f1f5f9;
}
.row.auto {
  background: #f0fdf4;
  margin: 0 -6px;
  padding-left: 6px;
  padding-right: 6px;
  border-radius: 8px;
}
.row:first-of-type { border-top: 0; }
.chk {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}
.chk input {
  width: 15px;
  height: 15px;
  accent-color: #0284c7;
}
.auto-tag {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: #15803d;
  background: #dcfce7;
  border: 1px solid #86efac;
  border-radius: 999px;
  padding: 1px 7px;
}
.iv-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.name-btn {
  flex: 1;
  min-width: 0;
  text-align: left;
  border: 0;
  background: transparent;
  font-size: 13px;
  font-weight: 650;
  color: #0f172a;
  cursor: pointer;
  padding: 4px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name-btn:hover { color: #0284c7; }
.mini {
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid #cbd5e1;
  background: #fff;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
  flex-shrink: 0;
}
.mini.primary { background: #0f172a; border-color: #0f172a; color: #fff; }
.mini.danger { border-color: #fecaca; color: #b91c1c; background: #fef2f2; }

.log-mask {
  position: fixed;
  inset: 0;
  z-index: 95;
  background: rgba(15, 23, 42, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.log-panel {
  width: min(720px, 100%);
  max-height: min(88vh, 900px);
  display: flex;
  flex-direction: column;
  background: #f8fafc;
  border-radius: 14px;
  border: 1px solid #cbd5e1;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
  overflow: hidden;
}
.log-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px 8px;
  border-bottom: 1px solid #e2e8f0;
  background: #fff;
}
.log-title { font-size: 16px; font-weight: 800; color: #0f172a; }
.log-sub { margin-top: 2px; font-size: 12px; color: #64748b; }
.log-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e8f0;
  background: #fff;
}
.log-toolbar select {
  height: 32px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0 8px;
  font-size: 12px;
  background: #fff;
}
.log-list {
  flex: 1;
  overflow: auto;
  padding: 10px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.log-row {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px 10px;
  background: #fff;
}
.log-row.run { background: #f1f5f9; border-color: #cbd5e1; }
.log-row.met { border-color: #86efac; background: #f0fdf4; }
.log-row.miss { border-color: #e2e8f0; }
.log-row.fail { border-color: #fca5a5; background: #fef2f2; }
.log-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.log-top .t {
  font-size: 12px;
  font-weight: 700;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.chip {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #334155;
}
.chip.ok { background: #bbf7d0; color: #166534; }
.chip.no { background: #e2e8f0; color: #64748b; }
.chip.sim { background: #fef3c7; color: #92400e; }
.log-match {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 2px;
}
.log-detail {
  font-size: 12px;
  color: #475569;
  line-height: 1.45;
}
.log-meta {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 650;
  color: #0f172a;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.err-txt { color: #b91c1c; }
</style>
