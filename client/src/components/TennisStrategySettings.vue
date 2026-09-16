<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import * as api from '../api'
import { normalizeInplayBettingEntry } from '../utils/tennisListFilters'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 当前编辑的独立策略 { strategyKey, name, id }；有值时只读写该策略，不与其它策略混在一起 */
  focusStrategy: { type: Object, default: null },
  /** 列表勾选的赛事摘要 */
  selectedMatches: { type: Array, default: () => [] },
  /** 可选赛事（弹出列表） */
  matchOptions: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:open', 'saved', 'remove-match', 'toggle-match', 'restore-matches', 'select-by-conditions', 'auto-bet'])

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const filterTip = ref('')
let filterTipTimer = null
const pickerOpen = ref(false)
const pickerQuery = ref('')

const selectedIdSet = computed(() => new Set(
  (props.selectedMatches || []).map((m) => String(m.id)),
))

const pickerFiltered = computed(() => {
  const q = pickerQuery.value.trim().toLowerCase()
  const list = Array.isArray(props.matchOptions) ? props.matchOptions : []
  if (!q) return list
  return list.filter((m) => {
    const hay = [m.home, m.away, m.tournament, m.statusLabel, m.timeBj].join(' ').toLowerCase()
    return hay.includes(q)
  })
})

function isPicked(id) {
  return selectedIdSet.value.has(String(id))
}

function togglePick(id) {
  emit('toggle-match', id)
}

function openPicker() {
  pickerQuery.value = ''
  pickerOpen.value = true
}

function emptyCondGroup() {
  return {
    id: `cg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    strategyKey: '',
    name: '',
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

function emptyStopRule() {
  return {
    name: '',
    joinPrev: 'or',
    stopFormat: 'any',
    stopSetIndex: 'all',
    stopStrongSets: 'all',
    stopWeakSets: 'all',
    stopGameLead: 'all',
    stopWeakGamesMin: 'all',
    stopPmCentsMax: 'all',
  }
}

function emptyBetGroup(kind) {
  return {
    id: `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    strategyKey: '',
    name: '',
    joinPrev: 'or',
    amountUsd: 1,
    stopEnabled: true,
    stopRules: [emptyStopRule()],
    stopIntervalSec: 60,
  }
}

function clampPollSec(raw, fallback = 60) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(600, Math.max(10, Math.round(n)))
}

function focusMeta() {
  const f = props.focusStrategy
  if (!f || typeof f !== 'object') return null
  const strategyKey = String(f.strategyKey || '').trim()
  const name = String(f.name || '').trim()
  const id = String(f.id || '').trim()
  if (!strategyKey && !name && !id) return null
  return { strategyKey, name, id }
}

/** 是否属于当前正在编辑的独立策略 */
function matchesFocus(g, focus = focusMeta()) {
  if (!focus) return true
  const gKey = String(g?.strategyKey || '').trim()
  if (focus.strategyKey && gKey && gKey === focus.strategyKey) return true
  if (focus.id && String(g?.id || '') === focus.id) return true
  const gName = String(g?.name || '').trim()
  const focusName = String(focus.name || '').trim()
  // 同名视为同一策略（列表不允许重名），收掉误产生的重复条
  if (focusName && gName && gName === focusName) return true
  return false
}

function stampFocus(g) {
  const focus = focusMeta()
  if (!focus) return g
  return {
    ...g,
    strategyKey: String(g?.strategyKey || '').trim() || focus.strategyKey || '',
    name: String(g?.name || '').trim() || focus.name || '',
  }
}

function numOrAll(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return 'all'
  const n = Number(s)
  return Number.isFinite(n) ? n : 'all'
}

function ensureStops(g) {
  return Array.isArray(g?.stopRules) && g.stopRules.length ? g.stopRules : [emptyStopRule()]
}

function normCondGroups(list) {
  const arr = Array.isArray(list) ? list : []
  if (!arr.length) return [emptyCondGroup()]
  return arr.map((g) => ({ ...emptyCondGroup(), ...g }))
}

function normBetGroups(list, kind) {
  const arr = Array.isArray(list) ? list : []
  if (!arr.length) return [emptyBetGroup(kind)]
  return arr.map((g) => ({
    ...emptyBetGroup(kind),
    ...g,
    amountUsd: Number(g.amountUsd) >= 1 ? Number(g.amountUsd) : 1,
    stopRules: ensureStops(g).map((r) => ({ ...emptyStopRule(), ...r })),
  }))
}

function emptyBucket(kind) {
  return {
    condOn: false,
    condGroups: [emptyCondGroup()],
    betOn: false,
    simulate: false,
    entry: normalizeInplayBettingEntry(null),
    amountUsd: 1,
    betGroups: [emptyBetGroup(kind)],
    conditionIntervalSec: 60,
    stopIntervalSec: 60,
  }
}

/** 从采集数据按条件自动选赛（关则只用下方已选手） */
const autoSelectFromCollect = ref(true)

const draft = ref({
  prematch: emptyBucket('prematch'),
  inplay: emptyBucket('inplay'),
})

/** true=收起；未设置默认收起 */
const folded = ref({})

function foldKey(...parts) {
  return parts.join(':')
}

function isFolded(key) {
  return folded.value[key] !== false
}

function toggleFold(key) {
  folded.value = { ...folded.value, [key]: !isFolded(key) }
}

function condTitle(g, gi) {
  const n = String(g?.name || '').trim()
  return n || `条件组 ${gi + 1}`
}

function stopGroupTitle(g, gi, kind) {
  const n = String(g?.name || '').trim()
  if (n) return n
  return kind === 'stop' ? `止损组 ${gi + 1}` : `卖出组 ${gi + 1}`
}

function stopRuleTitle(sr, si, kind) {
  const n = String(sr?.name || '').trim()
  if (n) return n
  return kind === 'stop' ? `止损 ${si + 1}` : `条件 ${si + 1}`
}

const title = computed(() => {
  const focus = focusMeta()
  if (focus?.name) return `策略设置 · ${focus.name}`
  return '策略设置 · 开赛前 / 比赛中'
})

/** 全量引擎配置快照，保存时把其它策略的组拼回去 */
const engineSnapshot = ref(null)

/** 某策略在调度中心是否仍有启用中的自动投注任务（按桶）
 * 只认 params.strategyKey，与策略列表「自动中」一致，避免仅凭任务 id 误判为开启
 */
async function fetchStrategyAutoBetFlags(strategyKey, altKeys = []) {
  const keys = new Set(
    [strategyKey, ...altKeys].map((s) => String(s || '').trim()).filter(Boolean),
  )
  const out = { prematch: false, inplay: false }
  if (!keys.size) return out
  try {
    const data = await api.fetchSchedulerJobs()
    const jobs = Array.isArray(data?.jobs) ? data.jobs : []
    for (const j of jobs) {
      if (!j?.enabled) continue
      const p = j.params || {}
      const id = String(j.id || '')
      const jt = String(j.jobType || '')
      const isBet = jt === 'bet.scan' || id.includes('stbuy') || id.includes('ststop') || id.includes('bet_scan')
      if (!isBet) continue
      const sk = String(p.strategyKey || '').trim()
      if (!sk || !keys.has(sk)) continue
      const bucket = String(p.bucket || '')
      if (bucket === 'inplay') out.inplay = true
      else if (bucket === 'prematch') out.prematch = true
      else {
        out.prematch = true
        out.inplay = true
      }
    }
  } catch { /* ignore */ }
  return out
}

/** 除 focus 外是否还有其它策略的自动投注任务 */
async function otherStrategiesStillAuto(exceptKey, bucket) {
  const except = String(exceptKey || '').trim()
  try {
    const data = await api.fetchSchedulerJobs()
    const jobs = Array.isArray(data?.jobs) ? data.jobs : []
    return jobs.some((j) => {
      if (!j?.enabled) return false
      const p = j.params || {}
      const id = String(j.id || '')
      const jt = String(j.jobType || '')
      const isBet = jt === 'bet.scan' || id.includes('stbuy') || id.includes('ststop') || id.includes('bet_scan')
      if (!isBet) return false
      const sk = String(p.strategyKey || '').trim()
      if (!sk || sk === except) return false
      const b = String(p.bucket || '')
      if (bucket && b && b !== bucket) return false
      return true
    })
  } catch {
    return false
  }
}

async function loadAll() {
  loading.value = true
  error.value = ''
  notice.value = ''
  filterTip.value = ''
  try {
    const cfg = await api.fetchTennisEngines()
    engineSnapshot.value = cfg
    const cond = cfg?.condition?.buckets || {}
    const bet = cfg?.betting?.buckets || {}
    const focus = focusMeta()
    // 详情「投注打开」跟列表「自动投注」对齐：只看本策略调度任务的 strategyKey
    const autoFlags = focus
      ? await fetchStrategyAutoBetFlags(focus.strategyKey, [focus.id])
      : { prematch: false, inplay: false }
    // 列表已停（无启用任务）时，清掉本策略残留调度，避免下次又被点亮
    if (focus?.strategyKey && !autoFlags.prematch && !autoFlags.inplay) {
      await disableFocusBetJobs().catch(() => {})
    }
    const build = (key) => {
      const c = cond[key] || {}
      const b = bet[key] || {}
      let cList = Array.isArray(c.groups) ? c.groups : []
      let bList = Array.isArray(b.groups) ? b.groups : []
      if (focus) {
        cList = cList.filter((g) => matchesFocus(g, focus))
        bList = bList.filter((g) => matchesFocus(g, focus))
        if (!cList.length) {
          cList = [stampFocus({ ...emptyCondGroup(), name: focus.name, strategyKey: focus.strategyKey })]
        }
        if (!bList.length) {
          bList = [stampFocus({ ...emptyBetGroup(key), name: focus.name, strategyKey: focus.strategyKey })]
        }
      }
      const groups = normBetGroups(bList, key).map(stampFocus)
      const amount = Number(groups.find((g) => Number(g.amountUsd) >= 1)?.amountUsd) || 1
      const condGroups = normCondGroups(cList).map(stampFocus)
      return {
        condOn: !!c.enabled,
        condGroups,
        betOn: !!autoFlags[key],
        simulate: !!b.simulate,
        entry: normalizeInplayBettingEntry(b.entry),
        amountUsd: amount,
        betGroups: groups,
        conditionIntervalSec: clampPollSec(condGroups[0]?.checkIntervalSec, 60),
        stopIntervalSec: clampPollSec(groups[0]?.stopIntervalSec, 60),
      }
    }
    const pm = build('prematch')
    const ip = build('inplay')
    draft.value = {
      prematch: pm,
      inplay: ip,
    }
    const flagSrc = pm.condGroups[0] || pm.betGroups[0] || ip.condGroups[0] || ip.betGroups[0] || {}
    autoSelectFromCollect.value = flagSrc.autoSelectFromCollect !== false
    const savedIds = []
    const seen = new Set()
    for (const g of [...pm.condGroups, ...pm.betGroups, ...ip.condGroups, ...ip.betGroups]) {
      for (const id of g.eventIds || []) {
        const s = String(id)
        if (s && !seen.has(s)) {
          seen.add(s)
          savedIds.push(s)
        }
      }
    }
    if (savedIds.length) emit('restore-matches', savedIds)
    // 打开详情只恢复已选，绝不顺带下单
    emitSelectByConditions({ placeOrders: false })
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

watch(() => props.open, (v) => {
  if (v) loadAll()
})

watch(() => props.focusStrategy, () => {
  if (props.open) loadAll()
})

let selectByCondTimer = null
watch(
  () => [
    autoSelectFromCollect.value,
    draft.value.prematch?.condOn,
    draft.value.inplay?.condOn,
    draft.value.prematch?.condGroups,
    draft.value.inplay?.condGroups,
  ],
  () => {
    if (!props.open || loading.value) return
    // 防抖：改条件时不要每次 keystroke 都全场重筛
    if (selectByCondTimer) clearTimeout(selectByCondTimer)
    selectByCondTimer = setTimeout(() => {
      emitSelectByConditions({ announce: true, placeOrders: false })
    }, 280)
  },
  { deep: true },
)

function setCondField(bucket, gi, key, raw) {
  const b = { ...draft.value[bucket] }
  const groups = [...b.condGroups]
  const g = { ...groups[gi] }
  if (key === 'joinPrev') g.joinPrev = raw === 'and' ? 'and' : 'or'
  else if (key === 'name') g.name = String(raw || '').slice(0, 40)
  else if (key === 'requireWonFirstSet' || key === 'firstSetExcludeEnabled') g[key] = !!raw
  else if (key === 'firstSetExcludeScore') g[key] = String(raw || '').trim().slice(0, 12) || '7:5'
  else if (['tour', 'pm', 'gapMode'].includes(key)) g[key] = raw
  else g[key] = numOrAll(raw)
  groups[gi] = g
  b.condGroups = groups
  draft.value = { ...draft.value, [bucket]: b }
}

function addCondGroup(bucket) {
  const b = { ...draft.value[bucket] }
  b.condGroups = [...b.condGroups, stampFocus({ ...emptyCondGroup(), joinPrev: 'or' })]
  draft.value = { ...draft.value, [bucket]: b }
}

function removeCondGroup(bucket, gi) {
  const b = { ...draft.value[bucket] }
  const next = b.condGroups.filter((_, i) => i !== gi)
  b.condGroups = next.length ? next : [stampFocus(emptyCondGroup())]
  draft.value = { ...draft.value, [bucket]: b }
}

function setAmount(bucket, raw) {
  const n = Number(raw)
  const amount = Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : 1
  const b = { ...draft.value[bucket] }
  b.amountUsd = amount
  b.betGroups = b.betGroups.map((g, i) => (i === 0 ? { ...g, amountUsd: amount } : g))
  draft.value = { ...draft.value, [bucket]: b }
}

function setEntryField(key, raw) {
  const b = { ...draft.value.inplay }
  const e = { ...normalizeInplayBettingEntry(b.entry) }
  if (key === 'requireWonFirstSet' || key === 'firstSetExcludeEnabled') e[key] = !!raw
  else if (key === 'firstSetExcludeScore') e[key] = String(raw || '').trim().slice(0, 12) || '7:5'
  else if (key === 'pmCentsMax') e.pmCentsMax = numOrAll(raw)
  b.entry = e
  draft.value = { ...draft.value, inplay: b }
}

function setBetGroupField(bucket, gi, key, raw) {
  const b = { ...draft.value[bucket] }
  const groups = [...b.betGroups]
  const g = { ...groups[gi] }
  if (key === 'joinPrev') g.joinPrev = raw === 'and' ? 'and' : 'or'
  else if (key === 'name') g.name = String(raw || '').slice(0, 40)
  else if (key === 'stopEnabled') g.stopEnabled = !!raw
  else if (key === 'amountUsd') {
    const n = Number(raw)
    g.amountUsd = Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : 1
    if (gi === 0) b.amountUsd = g.amountUsd
  }
  groups[gi] = g
  b.betGroups = groups
  draft.value = { ...draft.value, [bucket]: b }
}

function setStopField(bucket, gi, si, key, raw) {
  const b = { ...draft.value[bucket] }
  const groups = [...b.betGroups]
  const g = { ...groups[gi] }
  const rules = [...ensureStops(g)]
  const r = { ...emptyStopRule(), ...rules[si] }
  if (key === 'joinPrev') r.joinPrev = raw === 'and' ? 'and' : 'or'
  else if (key === 'name') r.name = String(raw || '').slice(0, 40)
  else if (key === 'stopFormat') r.stopFormat = raw || 'any'
  else r[key] = numOrAll(raw)
  rules[si] = r
  g.stopRules = rules
  groups[gi] = g
  b.betGroups = groups
  draft.value = { ...draft.value, [bucket]: b }
}

function addBetGroup(bucket) {
  const b = { ...draft.value[bucket] }
  b.betGroups = [...b.betGroups, stampFocus({ ...emptyBetGroup(bucket), amountUsd: b.amountUsd, joinPrev: 'or' })]
  draft.value = { ...draft.value, [bucket]: b }
}

function removeBetGroup(bucket, gi) {
  const b = { ...draft.value[bucket] }
  const next = b.betGroups.filter((_, i) => i !== gi)
  b.betGroups = next.length ? next : [stampFocus(emptyBetGroup(bucket))]
  draft.value = { ...draft.value, [bucket]: b }
}

function addStop(bucket, gi) {
  const b = { ...draft.value[bucket] }
  const groups = [...b.betGroups]
  const g = { ...groups[gi] }
  g.stopRules = [...ensureStops(g), emptyStopRule()]
  g.stopEnabled = true
  groups[gi] = g
  b.betGroups = groups
  draft.value = { ...draft.value, [bucket]: b }
}

function removeStop(bucket, gi, si) {
  const b = { ...draft.value[bucket] }
  const groups = [...b.betGroups]
  const g = { ...groups[gi] }
  const rules = ensureStops(g).filter((_, i) => i !== si)
  g.stopRules = rules.length ? rules : [emptyStopRule()]
  groups[gi] = g
  b.betGroups = groups
  draft.value = { ...draft.value, [bucket]: b }
}

function emitAutoBet(bucket) {
  const b = draft.value[bucket]
  if (!b?.betOn) return
  const amount = Number(b.amountUsd) >= 1 ? Number(b.amountUsd) : 1
  const label = bucket === 'inplay' ? '比赛中' : '开赛前'
  const mode = b.simulate ? '模拟' : '实盘'
  notice.value = `投注已打开（${mode}）：按 $${amount} 为已选${label}场次下单`
  setTimeout(() => {
    if (String(notice.value || '').startsWith('投注已打开')) notice.value = ''
  }, 2800)
  emit('auto-bet', {
    bucket,
    amountUsd: amount,
    simulate: !!b.simulate,
    strategyKey: focusMeta()?.strategyKey || '',
  })
}

async function disableFocusBetJobs(onlyBucket = null) {
  const focus = focusMeta()
  if (!focus?.strategyKey) return
  const sk = String(focus.strategyKey)
  const safe = safeJobKey(sk)
  const buckets = onlyBucket ? [onlyBucket] : ['prematch', 'inplay']
  let jobs = []
  try {
    const data = await api.fetchSchedulerJobs()
    jobs = Array.isArray(data?.jobs) ? data.jobs : []
  } catch {
    jobs = []
  }
  const ids = new Set()
  for (const j of jobs) {
    const p = j?.params || {}
    const id = String(j?.id || '')
    const jt = String(j?.jobType || '')
    const hitSk = String(p.strategyKey || '').trim() === sk
    const jb = String(p.bucket || '')
    const hitBucket = !onlyBucket || jb === onlyBucket || !jb
    const hitId = safe && buckets.some((b) => id.includes(`stbuy_${safe}_${b}`) || id.includes(`ststop_${safe}_${b}`))
    if (!(jt === 'bet.scan' || id.includes('stbuy') || id.includes('ststop'))) continue
    if ((!hitSk && !hitId) || !hitBucket) continue
    ids.add(id)
  }
  for (const bucket of buckets) {
    ids.add(`job_stbuy_${safe}_${bucket}`)
    ids.add(`job_ststop_${safe}_${bucket}`)
  }
  await Promise.all([...ids].filter(Boolean).map(async (id) => {
    try {
      await api.disableSchedulerJob(id)
    } catch {
      try { await api.patchSchedulerJob(id, { enabled: false }) } catch { /* ignore */ }
    }
  }))
}

function toggleFlag(bucket, key, checked) {
  const b = { ...draft.value[bucket], [key]: !!checked }
  draft.value = { ...draft.value, [bucket]: b }
  // 投注打开 → 立刻按文本框金额给已选赛事下单，并同步调度（不必等保存）
  if (key === 'betOn' && checked) {
    nextTick(() => {
      emitAutoBet(bucket)
      const focus = focusMeta()
      if (focus?.strategyKey) syncStrategyScheduleJobs(focus).catch(() => {})
    })
  }
  // 投注关闭 → 立刻停该桶调度，不必等保存
  if (key === 'betOn' && !checked) {
    disableFocusBetJobs(bucket).catch(() => {})
  }
}

function setScheduleSec(bucket, key, raw) {
  const b = { ...draft.value[bucket] }
  const sec = clampPollSec(raw, 60)
  b[key] = sec
  if (key === 'conditionIntervalSec') {
    b.condGroups = b.condGroups.map((g) => ({ ...g, checkIntervalSec: sec }))
  } else if (key === 'stopIntervalSec') {
    b.betGroups = b.betGroups.map((g) => ({ ...g, stopIntervalSec: sec }))
  }
  draft.value = { ...draft.value, [bucket]: b }
}

function jobMatchesUpsert(j, { id, params }) {
  if (!j) return false
  if (id && j.id === id) return true
  const p = j.params || {}
  const sk = String(p.strategyKey || '').trim()
  const wantSk = String(params?.strategyKey || '').trim()
  if (!sk || !wantSk || sk !== wantSk) return false
  if (String(p.bucket || '') !== String(params?.bucket || '')) return false
  const pm = String(p.mode || '').trim()
  const wm = String(params?.mode || '').trim()
  // 旧任务可能没有 mode，仍按桶匹配
  if (pm && wm && pm !== wm) return false
  return true
}

async function upsertScheduleJob({ id, name, jobType, intervalSec, enabled, params }, existingJobs) {
  const body = {
    name,
    scheduleMode: 'interval',
    intervalSec: clampPollSec(intervalSec, 60),
    enabled: !!enabled,
    params,
  }
  const list = Array.isArray(existingJobs) ? existingJobs : []
  const matches = list.filter((j) => jobMatchesUpsert(j, { id, params }))
  if (matches.length) {
    // 同一策略可能残留多个任务：全部改间隔/启停，避免旧任务仍按旧秒数跑
    await Promise.all(matches.map((j) => api.patchSchedulerJob(j.id, body)))
    const hasCanonical = matches.some((j) => j.id === id)
    if (!hasCanonical && id) {
      try {
        await api.createSchedulerJob({ id, jobType, ...body })
      } catch { /* 已有同 id 则忽略 */ }
    }
    return matches[0].id
  }
  await api.createSchedulerJob({
    id,
    jobType,
    ...body,
  })
  return id
}

/** 条件/止损各自写入调度中心任务：到点检查 → 满足则买入或止损 */
async function syncStrategyScheduleJobs(focus) {
  if (!focus?.strategyKey) return
  const sk = focus.strategyKey
  const safe = safeJobKey(sk)
  const label = String(focus.name || sk).slice(0, 40)
  let existingJobs = []
  try {
    const data = await api.fetchSchedulerJobs()
    existingJobs = Array.isArray(data?.jobs) ? data.jobs : []
  } catch {
    existingJobs = []
  }
  const tasks = []
  for (const bucket of ['prematch', 'inplay']) {
    const b = draft.value[bucket]
    const tag = bucket === 'inplay' ? '比赛中' : '开赛前'
    // 与策略列表「自动投注」一致：投注打开即维持扫描；间隔始终写入
    const buyOn = !!b.betOn && ((b.condGroups || []).length > 0 || !!b.condOn)
    const stopOn = !!b.betOn && (b.betGroups || []).some(
      (g) => g.stopEnabled !== false && Array.isArray(g.stopRules) && g.stopRules.length,
    )
    tasks.push(
      upsertScheduleJob({
        id: `job_stbuy_${safe}_${bucket}`,
        name: `${label}·${tag}·条件投注`,
        jobType: 'bet.scan',
        intervalSec: b.conditionIntervalSec,
        enabled: buyOn,
        params: { strategyKey: sk, bucket, mode: 'buy' },
      }, existingJobs),
      upsertScheduleJob({
        id: `job_ststop_${safe}_${bucket}`,
        name: `${label}·${tag}·止损`,
        jobType: 'bet.scan',
        intervalSec: b.stopIntervalSec,
        enabled: stopOn,
        params: { strategyKey: sk, bucket, mode: 'stop' },
      }, existingJobs),
    )
  }
  await Promise.all(tasks)
}

function showFilterDone() {
  if (!autoSelectFromCollect.value) return
  const n = (props.selectedMatches || []).length
  filterTip.value = `筛选完毕：已选 ${n} 场`
  if (filterTipTimer) clearTimeout(filterTipTimer)
  filterTipTimer = setTimeout(() => { filterTip.value = '' }, 2200)
}

async function emitSelectByConditions({ announce = false, placeOrders = true } = {}) {
  const pm = draft.value.prematch
  const ip = draft.value.inplay
  emit('select-by-conditions', {
    auto: !!autoSelectFromCollect.value,
    prematchOn: !!pm?.condOn,
    inplayOn: !!ip?.condOn,
    prematchGroups: pm?.condGroups || [],
    inplayGroups: ip?.condGroups || [],
  })
  if (!announce) return
  await nextTick()
  await nextTick()
  showFilterDone()
  // 保存策略时不下单；仅投注开关/筛选完成等路径才自动下单
  if (!placeOrders) return
  if (pm?.betOn) emitAutoBet('prematch')
  if (ip?.betOn) emitAutoBet('inplay')
}

function packCond(b) {
  const checkIntervalSec = clampPollSec(b.conditionIntervalSec, 60)
  const eventIds = (props.selectedMatches || []).map((m) => String(m.id)).filter(Boolean)
  const auto = !!autoSelectFromCollect.value
  return {
    enabled: !!b.condOn,
    groups: b.condGroups.map((g) => stampFocus({
      ...emptyCondGroup(),
      ...g,
      checkIntervalSec,
      autoSelectFromCollect: auto,
      eventIds,
    })),
  }
}

function packBet(b, kind) {
  const amount = Number(b.amountUsd) >= 1 ? Number(b.amountUsd) : 1
  const stopIntervalSec = clampPollSec(b.stopIntervalSec, 60)
  const eventIds = (props.selectedMatches || []).map((m) => String(m.id)).filter(Boolean)
  const auto = !!autoSelectFromCollect.value
  return {
    enabled: !!b.betOn,
    simulate: !!b.simulate,
    ...(kind === 'inplay' ? { entry: normalizeInplayBettingEntry(b.entry) } : {}),
    groups: b.betGroups.map((g, i) => stampFocus({
      ...emptyBetGroup(kind),
      ...g,
      amountUsd: i === 0 ? amount : (Number(g.amountUsd) >= 1 ? Number(g.amountUsd) : amount),
      stopIntervalSec,
      autoSelectFromCollect: auto,
      eventIds,
      stopRules: ensureStops(g).map((r) => ({ ...emptyStopRule(), ...r })),
    })),
  }
}

function mergeBucketGroups(existingGroups, editedGroups, focus) {
  const existing = Array.isArray(existingGroups) ? existingGroups : []
  const edited = Array.isArray(editedGroups) ? editedGroups : []
  if (!focus) return edited
  const focusKey = String(focus.strategyKey || '').trim()
  const focusName = String(focus.name || '').trim()
  const kept = existing.filter((g) => {
    if (matchesFocus(g, focus)) return false
    const gKey = String(g?.strategyKey || '').trim()
    if (focusKey && gKey && gKey === focusKey) return false
    const gName = String(g?.name || '').trim()
    if (focusName && gName && gName === focusName) return false
    return true
  })
  // 编辑结果统一打上同一 strategyKey，避免再裂成多条
  const stamped = edited.map((g) => ({
    ...g,
    strategyKey: String(g?.strategyKey || '').trim() || focusKey || String(g?.id || ''),
    name: String(g?.name || '').trim() || focusName || '',
  }))
  return [...kept, ...stamped]
}

function safeJobKey(strategyKey) {
  return String(strategyKey || 'x').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40) || 'x'
}

async function saveAll() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    // 只重筛已选，不下单（下单留给「投注打开」开关）
    emitSelectByConditions({ announce: true, placeOrders: false })
    await nextTick()
    const focus = focusMeta()
    const pm = packCond(draft.value.prematch)
    const ip = packCond(draft.value.inplay)
    const pmBet = packBet(draft.value.prematch, 'prematch')
    const ipBet = packBet(draft.value.inplay, 'inplay')

    let snap = engineSnapshot.value
    if (focus && !snap) {
      snap = await api.fetchTennisEngines()
    }
    const prevCond = snap?.condition?.buckets || {}
    const prevBet = snap?.betting?.buckets || {}

    // 桶级 enabled：本策略打开则开；本策略关掉时，仅当其它策略仍有自动任务才保持开
    let keepPrematchBet = false
    let keepInplayBet = false
    if (focus?.strategyKey && !pmBet.enabled) {
      keepPrematchBet = await otherStrategiesStillAuto(focus.strategyKey, 'prematch')
    }
    if (focus?.strategyKey && !ipBet.enabled) {
      keepInplayBet = await otherStrategiesStillAuto(focus.strategyKey, 'inplay')
    }

    const condPrematch = focus
      ? {
          enabled: !!(prevCond.prematch?.enabled || pm.enabled),
          groups: mergeBucketGroups(prevCond.prematch?.groups, pm.groups, focus),
        }
      : pm
    const condInplay = focus
      ? {
          enabled: !!(prevCond.inplay?.enabled || ip.enabled),
          groups: mergeBucketGroups(prevCond.inplay?.groups, ip.groups, focus),
        }
      : ip
    const betPrematch = focus
      ? {
          ...pmBet,
          enabled: !!pmBet.enabled || keepPrematchBet,
          groups: mergeBucketGroups(prevBet.prematch?.groups, pmBet.groups, focus),
        }
      : pmBet
    const betInplay = focus
      ? {
          ...ipBet,
          enabled: !!ipBet.enabled || keepInplayBet,
          groups: mergeBucketGroups(prevBet.inplay?.groups, ipBet.groups, focus),
          entry: ipBet.entry || normalizeInplayBettingEntry(prevBet.inplay?.entry),
        }
      : ipBet

    const saved = await api.updateTennisEngines({
      condition: {
        enabled: true,
        buckets: {
          prematch: condPrematch,
          inplay: condInplay,
        },
      },
      betting: {
        enabled: true,
        buckets: {
          prematch: betPrematch,
          inplay: betInplay,
        },
      },
    })

    let scheduleNote = ''
    if (focus?.strategyKey) {
      try {
        await syncStrategyScheduleJobs(focus)
        scheduleNote = '；已同步条件/止损调度'
      } catch (se) {
        scheduleNote = `；调度同步失败：${se?.response?.data?.error || se?.message || '未知错误'}`
      }
    }

    notice.value = (focus?.name
      ? `已保存策略「${focus.name}」`
      : '已保存：开赛前 / 比赛中 条件·金额·止损') + scheduleNote
    emit('saved')
    // 用保存接口返回值刷新快照，避免再拉一轮 engines
    if (saved && typeof saved === 'object') {
      engineSnapshot.value = saved
    }
    setTimeout(() => { notice.value = '' }, 2500)
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

function close() {
  emit('update:open', false)
}

function removeMatch(id) {
  emit('remove-match', id)
}

function matchLabel(m) {
  const home = m?.home || '—'
  const away = m?.away || '—'
  const st = m?.statusLabel || m?.status || ''
  const t = m?.timeBj || m?.timeSrc || m?.startTime || ''
  return [t, `${home} vs ${away}`, st].filter(Boolean).join(' · ')
}

function rankTxt(v) {
  return v != null && Number.isFinite(Number(v)) ? `#${v}` : '—'
}

function numTxt(v) {
  return v != null && Number.isFinite(Number(v)) ? String(v) : '—'
}
</script>

<template>
  <div v-if="open" class="ss-mask" @click.self="close">
    <div class="ss-page" role="dialog" aria-modal="true">
      <header class="ss-head">
        <div>
          <div class="ss-title">{{ title }}</div>
          <div class="ss-sub">
            <template v-if="focusStrategy?.name">
              <span>独立策略「{{ focusStrategy.name }}」：条件与止损各有检查间隔，到点检查并投注/止损</span>
              <label class="auto-collect-tog" title="勾选后从采集数据里按条件自动选赛；不勾选则只用下方已选手赛事">
                <input v-model="autoSelectFromCollect" type="checkbox" />
                从采集数据按条件自动选赛做投注/止损
              </label>
            </template>
            <template v-else>同一页配置开赛前与比赛中：投注条件 · 投注金额 · 止损条件</template>
          </div>
        </div>
        <div class="ss-actions">
          <button type="button" class="btn" :disabled="loading" @click="loadAll">重新加载</button>
          <button type="button" class="btn primary" :disabled="saving || loading" @click="saveAll">
            {{ saving ? '保存中…' : '保存全部' }}
          </button>
          <button type="button" class="btn ghost" @click="close">关闭</button>
        </div>
      </header>

      <div class="picked">
        <div class="picked-h">
          <span>已选赛事</span>
          <span class="picked-n">{{ selectedMatches.length }} 场</span>
          <span v-if="filterTip" class="filter-tip">{{ filterTip }}</span>
          <button type="button" class="btn pick-btn" @click="openPicker">选择赛事</button>
        </div>
        <div v-if="!selectedMatches.length" class="picked-empty">
          {{ autoSelectFromCollect
            ? '已开启自动选赛：条件一改立刻重算已选，不合条件的会移除'
            : '未开自动选赛：请点「选择赛事」勾选要投注/止损的场次' }}
        </div>
        <div v-else class="picked-list">
          <div v-for="m in selectedMatches" :key="m.id" class="picked-item">
            <div class="picked-main">
              <div class="picked-txt" :title="matchLabel(m)">{{ matchLabel(m) }}</div>
              <div class="picked-ranks">
                <span>现排名 {{ rankTxt(m.homeRank) }} / {{ rankTxt(m.awayRank) }}</span>
                <span>历史最高 {{ rankTxt(m.homeBest) }} / {{ rankTxt(m.awayBest) }}</span>
                <span>现差 {{ numTxt(m.gap) }}</span>
                <span>排差 {{ numTxt(m.rankDiff) }}</span>
              </div>
            </div>
            <button type="button" class="picked-x" title="取消选择此场" @click="removeMatch(m.id)">删除</button>
          </div>
        </div>
      </div>

      <div v-if="pickerOpen" class="picker-mask" @click.self="pickerOpen = false">
        <div class="picker-sheet" role="dialog" aria-modal="true">
          <div class="picker-head">
            <div>
              <div class="picker-title">选择赛事</div>
              <div class="picker-sub">已选 {{ selectedMatches.length }} · 可选 {{ matchOptions.length }}</div>
            </div>
            <button type="button" class="btn ghost" @click="pickerOpen = false">完成</button>
          </div>
          <input
            v-model="pickerQuery"
            class="picker-search"
            type="search"
            placeholder="搜球员 / 赛事"
          />
          <div class="picker-list">
            <label
              v-for="m in pickerFiltered"
              :key="m.id"
              class="picker-row"
              :class="{ on: isPicked(m.id) }"
            >
              <input
                type="checkbox"
                :checked="isPicked(m.id)"
                @change="togglePick(m.id)"
              />
              <div class="picker-body">
                <div class="picked-txt">{{ matchLabel(m) }}</div>
                <div class="picked-ranks">
                  <span>现排名 {{ rankTxt(m.homeRank) }} / {{ rankTxt(m.awayRank) }}</span>
                  <span>历史最高 {{ rankTxt(m.homeBest) }} / {{ rankTxt(m.awayBest) }}</span>
                  <span>现差 {{ numTxt(m.gap) }}</span>
                  <span>排差 {{ numTxt(m.rankDiff) }}</span>
                </div>
              </div>
            </label>
            <div v-if="!pickerFiltered.length" class="picked-empty">无匹配赛事</div>
          </div>
        </div>
      </div>

      <p v-if="error" class="msg err">{{ error }}</p>
      <p v-if="notice" class="msg ok">{{ notice }}</p>
      <p v-if="loading" class="msg">加载中…</p>

      <div v-else class="ss-grid">
        <!-- 开赛前 -->
        <section class="ss-col">
          <h2>开赛前</h2>

          <div class="block">
            <div class="block-h">
              <span>① 投注条件</span>
              <label class="tog"><input type="checkbox" :checked="draft.prematch.condOn" @change="toggleFlag('prematch', 'condOn', $event.target.checked)" /> 条件打开</label>
              <label class="sched">
                条件检查间隔(秒)
                <input
                  type="number"
                  min="10"
                  max="600"
                  step="1"
                  :value="draft.prematch.conditionIntervalSec"
                  title="到点检查条件，满足则投注；改完需点保存"
                  @input="setScheduleSec('prematch', 'conditionIntervalSec', $event.target.value)"
                  @change="setScheduleSec('prematch', 'conditionIntervalSec', $event.target.value)"
                />
              </label>
              <button type="button" class="mini add" @click="addCondGroup('prematch')">加一组</button>
            </div>
            <div v-for="(g, gi) in draft.prematch.condGroups" :key="g.id || gi" class="card">
              <div class="row fold-h" @click="toggleFold(foldKey('pm', 'cond', g.id || gi))">
                <button type="button" class="fold-btn" :aria-expanded="!isFolded(foldKey('pm', 'cond', g.id || gi))">
                  {{ isFolded(foldKey('pm', 'cond', g.id || gi)) ? '▸' : '▾' }}
                </button>
                <select v-if="gi > 0" :value="g.joinPrev || 'or'" @click.stop @change="setCondField('prematch', gi, 'joinPrev', $event.target.value)">
                  <option value="or">或</option>
                  <option value="and">且</option>
                </select>
                <span v-else class="tag">首组</span>
                <span class="fold-title">{{ condTitle(g, gi) }}</span>
                <input class="name" :value="g.name" placeholder="条件组名" @click.stop @change="setCondField('prematch', gi, 'name', $event.target.value)" />
                <button type="button" class="mini del" @click.stop="removeCondGroup('prematch', gi)">删</button>
              </div>
              <div v-show="!isFolded(foldKey('pm', 'cond', g.id || gi))" class="fields">
                <label>巡回
                  <select :value="g.tour || 'all'" @change="setCondField('prematch', gi, 'tour', $event.target.value)">
                    <option value="all">全部</option>
                    <option value="ATP">男</option>
                    <option value="WTA">女</option>
                  </select>
                </label>
                <label>PM
                  <select :value="g.pm || 'all'" @change="setCondField('prematch', gi, 'pm', $event.target.value)">
                    <option value="all">全部</option>
                    <option value="yes">有外链</option>
                    <option value="no">无外链</option>
                  </select>
                </label>
                <div class="cond-metrics">
                  <div class="range">
                    <span class="range-k">现差≥</span>
                    <label><input class="narrow" type="number" :value="g.gapMin === 'all' || g.gapMin == null ? '' : g.gapMin" placeholder="—" @change="setCondField('prematch', gi, 'gapMin', $event.target.value)" /></label>
                  </div>
                  <div class="range">
                    <span class="range-k">排差</span>
                    <label>≥ <input type="number" :value="g.rankDiffMin === 'all' || g.rankDiffMin == null ? '' : g.rankDiffMin" placeholder="—" @change="setCondField('prematch', gi, 'rankDiffMin', $event.target.value)" /></label>
                    <label>≤ <input type="number" :value="g.rankDiffMax === 'all' || g.rankDiffMax == null ? '' : g.rankDiffMax" placeholder="—" @change="setCondField('prematch', gi, 'rankDiffMax', $event.target.value)" /></label>
                  </div>
                  <div class="range">
                    <span class="range-k">强现</span>
                    <label>&gt; <input type="number" :value="g.strongRankGt === 'all' || g.strongRankGt == null ? '' : g.strongRankGt" placeholder="—" @change="setCondField('prematch', gi, 'strongRankGt', $event.target.value)" /></label>
                    <label>&lt; <input type="number" :value="g.strongRankLt === 'all' || g.strongRankLt == null ? '' : g.strongRankLt" placeholder="—" @change="setCondField('prematch', gi, 'strongRankLt', $event.target.value)" /></label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="block">
            <div class="block-h">
              <span>② 投注金额</span>
              <label class="tog"><input type="checkbox" :checked="draft.prematch.betOn" @change="toggleFlag('prematch', 'betOn', $event.target.checked)" /> 投注打开</label>
              <label class="tog"><input type="checkbox" :checked="draft.prematch.simulate" @change="toggleFlag('prematch', 'simulate', $event.target.checked)" /> 模拟投注</label>
            </div>
            <label class="amount">每场 $
              <input type="number" min="1" step="1" :value="draft.prematch.amountUsd" @change="setAmount('prematch', $event.target.value)" />
            </label>
            <div class="bet-hint">与策略列表「自动投注」一致：有调度任务则为开；关闭会停掉本策略扫描。勾选「模拟投注」走模拟单</div>
          </div>

          <div class="block">
            <div class="block-h">
              <span>③ 止损条件</span>
              <label class="sched">
                止损检查间隔(秒)
                <input
                  type="number"
                  min="10"
                  max="600"
                  step="1"
                  :value="draft.prematch.stopIntervalSec"
                  title="到点检查止损，满足则卖出；改完需点保存"
                  @input="setScheduleSec('prematch', 'stopIntervalSec', $event.target.value)"
                  @change="setScheduleSec('prematch', 'stopIntervalSec', $event.target.value)"
                />
              </label>
              <button type="button" class="mini add" @click="addBetGroup('prematch')">加止损组</button>
            </div>
            <div v-for="(g, gi) in draft.prematch.betGroups" :key="g.id || ('pbg' + gi)" class="card">
              <div class="row fold-h" @click="toggleFold(foldKey('pm', 'bet', g.id || gi))">
                <button type="button" class="fold-btn">{{ isFolded(foldKey('pm', 'bet', g.id || gi)) ? '▸' : '▾' }}</button>
                <span class="fold-title">{{ stopGroupTitle(g, gi, 'stop') }}</span>
                <input class="name" :value="g.name" :placeholder="`止损组 ${gi + 1}`" @click.stop @change="setBetGroupField('prematch', gi, 'name', $event.target.value)" />
                <label class="tog" @click.stop><input type="checkbox" :checked="g.stopEnabled !== false" @change="setBetGroupField('prematch', gi, 'stopEnabled', $event.target.checked)" /> 启用</label>
                <button type="button" class="mini del" @click.stop="removeBetGroup('prematch', gi)">删组</button>
                <button type="button" class="mini add" @click.stop="addStop('prematch', gi)">加一条</button>
              </div>
              <div v-show="!isFolded(foldKey('pm', 'bet', g.id || gi))">
                <div v-for="(sr, si) in ensureStops(g)" :key="'psr' + gi + si" class="stop">
                  <div class="row fold-h" @click="toggleFold(foldKey('pm', 'stop', g.id || gi, si))">
                    <button type="button" class="fold-btn">{{ isFolded(foldKey('pm', 'stop', g.id || gi, si)) ? '▸' : '▾' }}</button>
                    <select v-if="si > 0" :value="sr.joinPrev || 'or'" @click.stop @change="setStopField('prematch', gi, si, 'joinPrev', $event.target.value)">
                      <option value="or">或</option>
                      <option value="and">且</option>
                    </select>
                    <span v-else class="tag">止损</span>
                    <span class="fold-title">{{ stopRuleTitle(sr, si, 'stop') }}</span>
                    <input class="name" :value="sr.name" :placeholder="`止损 ${si + 1}`" @click.stop @change="setStopField('prematch', gi, si, 'name', $event.target.value)" />
                    <button type="button" class="mini del" :disabled="ensureStops(g).length <= 1" @click.stop="removeStop('prematch', gi, si)">删</button>
                  </div>
                  <div v-show="!isFolded(foldKey('pm', 'stop', g.id || gi, si))" class="fields">
                    <label>赛制
                      <select :value="sr.stopFormat || 'any'" @change="setStopField('prematch', gi, si, 'stopFormat', $event.target.value)">
                        <option value="any">不限</option>
                        <option value="bo3">BO3</option>
                        <option value="bo5">BO5</option>
                      </select>
                    </label>
                    <label>第几盘 <input type="number" min="1" max="5" :value="sr.stopSetIndex === 'all' || sr.stopSetIndex == null ? '' : sr.stopSetIndex" placeholder="—" @change="setStopField('prematch', gi, si, 'stopSetIndex', $event.target.value)" /></label>
                    <div class="cond-metrics">
                      <label>强者已胜盘 <input type="number" :value="sr.stopStrongSets === 'all' || sr.stopStrongSets == null ? '' : sr.stopStrongSets" placeholder="—" @change="setStopField('prematch', gi, si, 'stopStrongSets', $event.target.value)" /></label>
                      <label>弱者已胜盘 <input type="number" :value="sr.stopWeakSets === 'all' || sr.stopWeakSets == null ? '' : sr.stopWeakSets" placeholder="—" @change="setStopField('prematch', gi, si, 'stopWeakSets', $event.target.value)" /></label>
                      <label>局差≥ <input type="number" :value="sr.stopGameLead === 'all' || sr.stopGameLead == null ? '' : sr.stopGameLead" placeholder="—" @change="setStopField('prematch', gi, si, 'stopGameLead', $event.target.value)" /></label>
                      <label>PM¢≤ <input type="number" :value="sr.stopPmCentsMax === 'all' || sr.stopPmCentsMax == null ? '' : sr.stopPmCentsMax" placeholder="—" @change="setStopField('prematch', gi, si, 'stopPmCentsMax', $event.target.value)" /></label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 比赛中 -->
        <section class="ss-col inplay">
          <h2>比赛中</h2>

          <div class="block">
            <div class="block-h">
              <span>① 投注条件</span>
              <label class="tog"><input type="checkbox" :checked="draft.inplay.condOn" @change="toggleFlag('inplay', 'condOn', $event.target.checked)" /> 条件打开</label>
              <label class="sched">
                条件检查间隔(秒)
                <input
                  type="number"
                  min="10"
                  max="600"
                  step="1"
                  :value="draft.inplay.conditionIntervalSec"
                  title="到点检查条件，满足则投注；改完需点保存"
                  @input="setScheduleSec('inplay', 'conditionIntervalSec', $event.target.value)"
                  @change="setScheduleSec('inplay', 'conditionIntervalSec', $event.target.value)"
                />
              </label>
              <button type="button" class="mini add" @click="addCondGroup('inplay')">加一组</button>
            </div>
            <div class="entry">
              <div class="entry-title">买入附加（投注引擎）</div>
              <div class="fields">
                <label class="tog"><input type="checkbox" :checked="!!draft.inplay.entry.requireWonFirstSet" @change="setEntryField('requireWonFirstSet', $event.target.checked)" /> 须赢首盘</label>
                <label v-if="draft.inplay.entry.requireWonFirstSet" class="tog"><input type="checkbox" :checked="!!draft.inplay.entry.firstSetExcludeEnabled" @change="setEntryField('firstSetExcludeEnabled', $event.target.checked)" /> 排除首盘</label>
                <label v-if="draft.inplay.entry.requireWonFirstSet && draft.inplay.entry.firstSetExcludeEnabled">局分
                  <input type="text" :value="draft.inplay.entry.firstSetExcludeScore || '7:5'" @change="setEntryField('firstSetExcludeScore', $event.target.value)" />
                </label>
                <label>PM¢&lt;
                  <input type="number" min="1" max="99" :value="draft.inplay.entry.pmCentsMax === 'all' || draft.inplay.entry.pmCentsMax == null ? '' : draft.inplay.entry.pmCentsMax" placeholder="不限" @change="setEntryField('pmCentsMax', $event.target.value)" />
                </label>
              </div>
            </div>
            <div v-for="(g, gi) in draft.inplay.condGroups" :key="g.id || ('ic' + gi)" class="card">
              <div class="row fold-h" @click="toggleFold(foldKey('ip', 'cond', g.id || gi))">
                <button type="button" class="fold-btn">{{ isFolded(foldKey('ip', 'cond', g.id || gi)) ? '▸' : '▾' }}</button>
                <select v-if="gi > 0" :value="g.joinPrev || 'or'" @click.stop @change="setCondField('inplay', gi, 'joinPrev', $event.target.value)">
                  <option value="or">或</option>
                  <option value="and">且</option>
                </select>
                <span v-else class="tag">首组</span>
                <span class="fold-title">{{ condTitle(g, gi) }}</span>
                <input class="name" :value="g.name" placeholder="条件组名" @click.stop @change="setCondField('inplay', gi, 'name', $event.target.value)" />
                <button type="button" class="mini del" @click.stop="removeCondGroup('inplay', gi)">删</button>
              </div>
              <div v-show="!isFolded(foldKey('ip', 'cond', g.id || gi))" class="fields">
                <label>巡回
                  <select :value="g.tour || 'all'" @change="setCondField('inplay', gi, 'tour', $event.target.value)">
                    <option value="all">全部</option>
                    <option value="ATP">男</option>
                    <option value="WTA">女</option>
                  </select>
                </label>
                <label>PM
                  <select :value="g.pm || 'all'" @change="setCondField('inplay', gi, 'pm', $event.target.value)">
                    <option value="all">全部</option>
                    <option value="yes">有外链</option>
                    <option value="no">无外链</option>
                  </select>
                </label>
                <label class="tog"><input type="checkbox" :checked="!!g.requireWonFirstSet" @change="setCondField('inplay', gi, 'requireWonFirstSet', $event.target.checked)" /> 赢首盘</label>
                <div class="cond-metrics">
                  <div class="range">
                    <span class="range-k">现差≥</span>
                    <label><input class="narrow" type="number" :value="g.gapMin === 'all' || g.gapMin == null ? '' : g.gapMin" placeholder="—" @change="setCondField('inplay', gi, 'gapMin', $event.target.value)" /></label>
                  </div>
                  <div class="range">
                    <span class="range-k">排差</span>
                    <label>≥ <input type="number" :value="g.rankDiffMin === 'all' || g.rankDiffMin == null ? '' : g.rankDiffMin" placeholder="—" @change="setCondField('inplay', gi, 'rankDiffMin', $event.target.value)" /></label>
                    <label>≤ <input type="number" :value="g.rankDiffMax === 'all' || g.rankDiffMax == null ? '' : g.rankDiffMax" placeholder="—" @change="setCondField('inplay', gi, 'rankDiffMax', $event.target.value)" /></label>
                  </div>
                  <div class="range">
                    <span class="range-k">强现</span>
                    <label>&gt; <input type="number" :value="g.strongRankGt === 'all' || g.strongRankGt == null ? '' : g.strongRankGt" placeholder="—" @change="setCondField('inplay', gi, 'strongRankGt', $event.target.value)" /></label>
                    <label>&lt; <input type="number" :value="g.strongRankLt === 'all' || g.strongRankLt == null ? '' : g.strongRankLt" placeholder="—" @change="setCondField('inplay', gi, 'strongRankLt', $event.target.value)" /></label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="block">
            <div class="block-h">
              <span>② 投注金额</span>
              <label class="tog"><input type="checkbox" :checked="draft.inplay.betOn" @change="toggleFlag('inplay', 'betOn', $event.target.checked)" /> 投注打开</label>
              <label class="tog"><input type="checkbox" :checked="draft.inplay.simulate" @change="toggleFlag('inplay', 'simulate', $event.target.checked)" /> 模拟投注</label>
            </div>
            <label class="amount">每场 $
              <input type="number" min="1" step="1" :value="draft.inplay.amountUsd" @change="setAmount('inplay', $event.target.value)" />
            </label>
            <div class="bet-hint">与策略列表「自动投注」一致：有调度任务则为开；关闭会停掉本策略扫描。勾选「模拟投注」走模拟单</div>
          </div>

          <div class="block">
            <div class="block-h">
              <span>③ 止损 / 卖出条件</span>
              <label class="sched">
                止损检查间隔(秒)
                <input
                  type="number"
                  min="10"
                  max="600"
                  step="1"
                  :value="draft.inplay.stopIntervalSec"
                  title="到点检查止损，满足则卖出；改完需点保存"
                  @input="setScheduleSec('inplay', 'stopIntervalSec', $event.target.value)"
                  @change="setScheduleSec('inplay', 'stopIntervalSec', $event.target.value)"
                />
              </label>
              <button type="button" class="mini add" @click="addBetGroup('inplay')">加组</button>
            </div>
            <div v-for="(g, gi) in draft.inplay.betGroups" :key="g.id || ('ibg' + gi)" class="card">
              <div class="row fold-h" @click="toggleFold(foldKey('ip', 'bet', g.id || gi))">
                <button type="button" class="fold-btn">{{ isFolded(foldKey('ip', 'bet', g.id || gi)) ? '▸' : '▾' }}</button>
                <span class="fold-title">{{ stopGroupTitle(g, gi, 'sell') }}</span>
                <input class="name" :value="g.name" :placeholder="`条件组 ${gi + 1}`" @click.stop @change="setBetGroupField('inplay', gi, 'name', $event.target.value)" />
                <label class="tog" @click.stop><input type="checkbox" :checked="g.stopEnabled !== false" @change="setBetGroupField('inplay', gi, 'stopEnabled', $event.target.checked)" /> 启用</label>
                <button type="button" class="mini del" @click.stop="removeBetGroup('inplay', gi)">删组</button>
                <button type="button" class="mini add" @click.stop="addStop('inplay', gi)">加一条</button>
              </div>
              <div v-show="!isFolded(foldKey('ip', 'bet', g.id || gi))">
                <div v-for="(sr, si) in ensureStops(g)" :key="'isr' + gi + si" class="stop">
                  <div class="row fold-h" @click="toggleFold(foldKey('ip', 'stop', g.id || gi, si))">
                    <button type="button" class="fold-btn">{{ isFolded(foldKey('ip', 'stop', g.id || gi, si)) ? '▸' : '▾' }}</button>
                    <select v-if="si > 0" :value="sr.joinPrev || 'or'" @click.stop @change="setStopField('inplay', gi, si, 'joinPrev', $event.target.value)">
                      <option value="or">或</option>
                      <option value="and">且</option>
                    </select>
                    <span v-else class="tag">条件</span>
                    <span class="fold-title">{{ stopRuleTitle(sr, si, 'sell') }}</span>
                    <input class="name" :value="sr.name" :placeholder="`条件 ${si + 1}`" @click.stop @change="setStopField('inplay', gi, si, 'name', $event.target.value)" />
                    <button type="button" class="mini del" :disabled="ensureStops(g).length <= 1" @click.stop="removeStop('inplay', gi, si)">删</button>
                  </div>
                  <div v-show="!isFolded(foldKey('ip', 'stop', g.id || gi, si))" class="fields">
                    <label>赛制
                      <select :value="sr.stopFormat || 'any'" @change="setStopField('inplay', gi, si, 'stopFormat', $event.target.value)">
                        <option value="any">不限</option>
                        <option value="bo3">BO3</option>
                        <option value="bo5">BO5</option>
                      </select>
                    </label>
                    <label>第几盘 <input type="number" min="1" max="5" :value="sr.stopSetIndex === 'all' || sr.stopSetIndex == null ? '' : sr.stopSetIndex" placeholder="—" @change="setStopField('inplay', gi, si, 'stopSetIndex', $event.target.value)" /></label>
                    <div class="cond-metrics">
                      <label>强者已胜盘 <input type="number" :value="sr.stopStrongSets === 'all' || sr.stopStrongSets == null ? '' : sr.stopStrongSets" placeholder="—" @change="setStopField('inplay', gi, si, 'stopStrongSets', $event.target.value)" /></label>
                      <label>弱者已胜盘 <input type="number" :value="sr.stopWeakSets === 'all' || sr.stopWeakSets == null ? '' : sr.stopWeakSets" placeholder="—" @change="setStopField('inplay', gi, si, 'stopWeakSets', $event.target.value)" /></label>
                      <label>局差≥ <input type="number" :value="sr.stopGameLead === 'all' || sr.stopGameLead == null ? '' : sr.stopGameLead" placeholder="—" @change="setStopField('inplay', gi, si, 'stopGameLead', $event.target.value)" /></label>
                      <label>PM¢≤ <input type="number" :value="sr.stopPmCentsMax === 'all' || sr.stopPmCentsMax == null ? '' : sr.stopPmCentsMax" placeholder="—" @change="setStopField('inplay', gi, si, 'stopPmCentsMax', $event.target.value)" /></label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ss-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 23, 42, 0.55);
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 12px;
}
.ss-page {
  width: min(1400px, 100%);
  max-height: calc(100vh - 24px);
  overflow: auto;
  background: #f8fafc;
  border-radius: 14px;
  border: 1px solid #cbd5e1;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
  padding: 14px 16px 20px;
}
.ss-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.ss-title { font-size: 18px; font-weight: 800; color: #0f172a; }
.ss-sub {
  margin-top: 4px;
  font-size: 12px;
  color: #64748b;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}
.auto-collect-tog {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 650;
  color: #0f172a;
  cursor: pointer;
  user-select: none;
  padding: 3px 8px;
  border-radius: 7px;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
}
.auto-collect-tog input {
  width: 14px;
  height: 14px;
  accent-color: #059669;
}
.picked {
  margin: 0 0 12px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}
.picked-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 700;
  color: #334155;
}
.filter-tip {
  font-size: 12px;
  font-weight: 650;
  color: #047857;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 999px;
  padding: 2px 10px;
}
.btn.pick-btn {
  margin-left: auto;
  height: 30px;
  padding: 0 12px;
  border: 1px solid #0369a1;
  background: #0284c7;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 1px 2px rgba(3, 105, 161, 0.25);
}
.btn.pick-btn:hover {
  background: #0369a1;
  border-color: #075985;
  color: #fff;
}
.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(15, 23, 42, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.picker-sheet {
  width: min(720px, 100%);
  max-height: min(80vh, 640px);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #cbd5e1;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.28);
  overflow: hidden;
}
.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #e2e8f0;
}
.picker-title { font-size: 15px; font-weight: 800; color: #0f172a; }
.picker-sub { margin-top: 2px; font-size: 12px; color: #64748b; }
.picker-search {
  margin: 10px 14px 0;
  height: 34px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0 10px;
  font-size: 13px;
}
.picker-list {
  flex: 1;
  overflow: auto;
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.picker-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  cursor: pointer;
}
.picker-row.on {
  border-color: #7dd3fc;
  background: #f0f9ff;
}
.picker-row input {
  margin-top: 3px;
}
.picker-body { flex: 1; min-width: 0; }
.picked-n {
  font-size: 12px;
  font-weight: 600;
  color: #0284c7;
}
.picked-empty {
  font-size: 12px;
  color: #94a3b8;
}
.picked-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 140px;
  overflow: auto;
}
.picked-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}
.picked-main {
  flex: 1;
  min-width: 0;
}
.picked-txt {
  font-size: 12px;
  font-weight: 650;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.picked-ranks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 4px;
  font-size: 11px;
  color: #475569;
  font-variant-numeric: tabular-nums;
}
.picked-ranks span {
  white-space: nowrap;
}
.picked-x {
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  margin-top: 2px;
}
.ss-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid #94a3b8;
  background: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn.primary { background: #0f172a; border-color: #0f172a; color: #fff; }
.btn.ghost { background: #e2e8f0; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.msg { margin: 0 0 8px; font-size: 13px; }
.msg.err { color: #b91c1c; }
.msg.ok { color: #047857; }

.ss-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 1100px) {
  .ss-grid { grid-template-columns: 1fr; }
}
.ss-col {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px;
}
.ss-col.inplay { border-color: #fecdd3; }
.ss-col h2 {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 800;
  color: #0369a1;
}
.ss-col.inplay h2 { color: #be123c; }
.block { margin-bottom: 14px; }
.block-h {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 700;
  color: #334155;
}
.card, .entry, .stop {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px;
  margin-bottom: 8px;
  background: #f8fafc;
}
.entry { background: #fff7ed; border-color: #fed7aa; }
.entry-title { font-size: 12px; font-weight: 700; color: #9a3412; margin-bottom: 6px; }
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
}
.cond-metrics {
  flex: 1 1 100%;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
}
.range {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}
.range-k {
  font-size: 11px;
  font-weight: 700;
  color: #475569;
  white-space: nowrap;
}
.fields .range label,
.range label {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #64748b;
  font-weight: 600;
}
.range input {
  width: 64px;
  min-width: 64px;
}
.range input.narrow {
  width: 52px;
  min-width: 52px;
}
.fields label, .amount {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: #64748b;
  font-weight: 600;
}
.fields label.tog, .tog {
  flex-direction: row;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #334155;
}
.fields input, .fields select, .name, .amount input, .row select {
  height: 30px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  padding: 0 8px;
  font-size: 12px;
  background: #fff;
  color: #0f172a;
  min-width: 72px;
}
.name { flex: 1; min-width: 100px; }
.amount {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #0f172a;
}
.amount input { width: 88px; font-weight: 700; }
.bet-hint {
  margin-top: 8px;
  font-size: 12px;
  color: #64748b;
  line-height: 1.4;
}
.block-h .sched {
  margin-left: auto;
}
.sched {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: #334155;
  white-space: nowrap;
}
.sched input {
  width: 88px;
  height: 30px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 700;
  background: #fff;
  color: #0f172a;
}
.mini {
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid #cbd5e1;
  background: #fff;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.mini.add {
  border-color: #86efac;
  background: #dcfce7;
  color: #166534;
}
.mini.add:hover {
  background: #bbf7d0;
}
.mini.del {
  border-color: #fca5a5;
  background: #fee2e2;
  color: #b91c1c;
}
.mini.del:hover:not(:disabled) {
  background: #fecaca;
}
.mini.del:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.fold-h {
  cursor: pointer;
  user-select: none;
}
.fold-btn {
  width: 22px;
  height: 22px;
  border: 0;
  background: transparent;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}
.fold-title {
  font-size: 12px;
  font-weight: 700;
  color: #0f172a;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  min-width: 32px;
}
</style>
