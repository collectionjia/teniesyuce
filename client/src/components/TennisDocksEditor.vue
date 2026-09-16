<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import * as api from '../api'
import { rankMetrics } from '../utils/tennisListFilters'

const props = defineProps({
  initialDate: { type: String, default: '' },
  /** 新标签全屏页：铺满浏览器、常规表格 */
  standalone: { type: Boolean, default: false },
})

const loading = ref(false)
const savingId = ref('')
const applying = ref(false)
const resimming = ref(false)
const clearing = ref(false)
const adding = ref(false)
const showAddForm = ref(false)
const error = ref('')
const notice = ref('')

const days = ref([])
const selectedDate = ref('')
const phasesLocked = ref(false)
const virtualSim = ref(null)
const matches = ref([])
const drafts = ref({})
const editingId = ref('')
/** 弹窗独立表单，避免 computed 上 v-model 写不回 drafts */
const editForm = ref(null)
const editingDraft = computed(() => editForm.value)
const editingMatch = computed(() => {
  if (!editingId.value) return null
  return matches.value.find((x) => String(x.id) === editingId.value) || null
})

const filterPhase = ref('all')
const filterTour = ref('all')
const filterQ = ref('')
const filterPm = ref('all')
const filterGapMin = ref('all')
const filterRankDiffMax = ref('all')
const filterStrongRankMax = ref('all')
/** 选用条件引擎已保存组：'all' | 'prematch:0' */
const filterGroupId = ref('all')
const conditionGroupOptions = ref([])
const page = ref(1)
const pageSize = ref(20)

const RANK_OPTS = [
  { value: 'all', label: '不限' },
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '20', label: '20' },
  { value: '30', label: '30' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '150', label: '150' },
]

const GAP_OPTS = [
  { value: 'all', label: '不限' },
  { value: '10', label: '≥10' },
  { value: '20', label: '≥20' },
  { value: '30', label: '≥30' },
  { value: '50', label: '≥50' },
  { value: '100', label: '≥100' },
]

const DIFF_OPTS = [
  { value: 'all', label: '不限' },
  { value: '0', label: '≤0' },
  { value: '5', label: '≤5' },
  { value: '10', label: '≤10' },
  { value: '20', label: '≤20' },
  { value: '50', label: '≤50' },
]

const addForm = ref(emptyAddForm())

function emptyAddForm() {
  return {
    phase: 'prematch',
    tour: 'ATP',
    tournament: '',
    home: '',
    away: '',
    homeRank: '',
    awayRank: '',
    homeBest: '',
    awayBest: '',
    scoreSets: [{ home: '', away: '' }],
    finalScoreSets: [{ home: '', away: '' }],
    polymarketUrl: '',
    pmHome: '',
    pmAway: '',
  }
}

const PHASE_OPTS = [
  { id: 'prematch', label: '盘前' },
  { id: 'inplay', label: '盘中' },
  { id: 'settled', label: '盘后' },
]

function phaseLabel(p) {
  return PHASE_OPTS.find((x) => x.id === p)?.label || p || '-'
}

function fmtTs(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  try {
    return new Date(n * 1000).toISOString().slice(0, 16)
  } catch {
    return ''
  }
}

function parseLocalTs(v) {
  const s = String(v || '').trim()
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return Math.floor(d.getTime() / 1000)
}

function fmtPmPair(m) {
  const h = m?.pmHome
  const a = m?.pmAway
  if (h == null || a == null || h === '' || a === '') return ''
  return `${h}¢/${a}¢`
}

/** "6-4 7-5 3-2" → [{home,away}, ...] */
function parseScoreSets(text) {
  const out = []
  for (const p of String(text || '').trim().split(/\s+/)) {
    if (!p) continue
    const m = p.match(/^(\d+)(?:\(\d+\))?-(\d+)(?:\(\d+\))?$/)
    if (m) out.push({ home: m[1], away: m[2] })
  }
  return out
}

function joinScoreSets(sets) {
  return (sets || [])
    .map((s) => {
      const h = String(s?.home ?? '').trim()
      const a = String(s?.away ?? '').trim()
      if (h === '' && a === '') return ''
      return `${h || '0'}-${a || '0'}`
    })
    .filter(Boolean)
    .join(' ')
}

function cloneDraft(m) {
  const scoreText = m.scoreText || ''
  const finalScoreText = m.finalScoreText || ''
  const scoreSets = parseScoreSets(scoreText)
  const finalScoreSets = parseScoreSets(finalScoreText)
  return {
    id: String(m.id),
    phase: m.phase || 'settled',
    home: m.home || '',
    away: m.away || '',
    homeRank: m.homeRank ?? '',
    awayRank: m.awayRank ?? '',
    homeBest: m.homeBest ?? '',
    awayBest: m.awayBest ?? '',
    scoreText,
    finalScoreText,
    scoreSets: scoreSets.length ? scoreSets : [{ home: '', away: '' }],
    finalScoreSets: finalScoreSets.length ? finalScoreSets : [{ home: '', away: '' }],
    startLocal: fmtTs(m.startTimestamp),
    polymarketUrl: m.polymarketUrl || '',
    pmHome: m.pmHome != null && m.pmHome !== '' ? m.pmHome : '',
    pmAway: m.pmAway != null && m.pmAway !== '' ? m.pmAway : '',
    tournament: m.tournament || '',
    tour: m.tour || 'ATP',
  }
}

function addScoreSet(draft, key) {
  if (!draft) return
  const list = Array.isArray(draft[key]) ? draft[key] : []
  draft[key] = [...list, { home: '', away: '' }]
}

function removeScoreSet(draft, key, idx) {
  if (!draft) return
  const list = Array.isArray(draft[key]) ? [...draft[key]] : []
  if (list.length <= 1) {
    draft[key] = [{ home: '', away: '' }]
    return
  }
  list.splice(idx, 1)
  draft[key] = list
}

function syncDrafts(list) {
  const next = {}
  for (const m of list || []) {
    next[String(m.id)] = cloneDraft(m)
  }
  drafts.value = next
}

function asFilterMatch(m) {
  return {
    id: m.id,
    tour: m.tour,
    home: m.home,
    away: m.away,
    polymarketUrl: m.polymarketUrl,
    homePlayer: {
      name: m.home,
      ranking: Number(m.homeRank) > 0 ? Number(m.homeRank) : null,
      bestRank: Number(m.homeBest) > 0 ? Number(m.homeBest) : null,
    },
    awayPlayer: {
      name: m.away,
      ranking: Number(m.awayRank) > 0 ? Number(m.awayRank) : null,
      bestRank: Number(m.awayBest) > 0 ? Number(m.awayBest) : null,
    },
  }
}

function isLimited(v) {
  return v != null && v !== '' && v !== 'all'
}

/** 与条件引擎单组规则一致（编辑页跳过首盘局分规则） */
function matchPassesRules(m, rules = {}) {
  const shaped = asFilterMatch(m)
  const tour = rules.tour
  if (tour && tour !== 'all') {
    const t = String(m.tour || '').toUpperCase()
    if (tour === 'ATP' || tour === '男') {
      if (t !== 'ATP') return false
    } else if (tour === 'WTA' || tour === '女') {
      if (t !== 'WTA') return false
    } else if (t !== String(tour).toUpperCase()) {
      return false
    }
  }
  const pm = rules.pm
  if (pm === 'yes' && !m.polymarketUrl) return false
  if (pm === 'no' && m.polymarketUrl) return false

  const metrics = rankMetrics(shaped)
  if (isLimited(rules.strongRankMax)) {
    if (!metrics.ready || metrics.strongRank > Number(rules.strongRankMax)) return false
  }
  if (isLimited(rules.strongRankGt)) {
    if (!metrics.ready || !(metrics.strongRank > Number(rules.strongRankGt))) return false
  }
  if (isLimited(rules.strongRankLt)) {
    if (!metrics.ready || !(metrics.strongRank < Number(rules.strongRankLt))) return false
  }
  if (isLimited(rules.gapMin)) {
    if (!metrics.ready || metrics.gap < Number(rules.gapMin)) return false
  }
  if (isLimited(rules.rankDiffMin)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff < Number(rules.rankDiffMin)) return false
  }
  if (isLimited(rules.rankDiffMax)) {
    if (!metrics.ready || metrics.rankDiff == null || metrics.rankDiff > Number(rules.rankDiffMax)) return false
  }
  return true
}

function activeCondRules() {
  if (filterGroupId.value !== 'all') {
    const opt = conditionGroupOptions.value.find((o) => o.id === filterGroupId.value)
    if (opt?.rules) return { ...opt.rules }
  }
  return {
    tour: 'all',
    pm: filterPm.value,
    gapMin: filterGapMin.value,
    rankDiffMax: filterRankDiffMax.value,
    strongRankMax: filterStrongRankMax.value,
  }
}

const phaseCounts = computed(() => {
  const list = matches.value || []
  return {
    all: list.length,
    prematch: list.filter((m) => m.phase === 'prematch').length,
    inplay: list.filter((m) => m.phase === 'inplay').length,
    settled: list.filter((m) => m.phase === 'settled').length,
  }
})

const filteredMatches = computed(() => {
  const q = filterQ.value.trim().toLowerCase()
  const rules = activeCondRules()
  return (matches.value || []).filter((m) => {
    if (filterPhase.value !== 'all' && m.phase !== filterPhase.value) return false
    if (filterTour.value !== 'all' && String(m.tour || '').toUpperCase() !== filterTour.value) return false
    if (!matchPassesRules(m, rules)) return false
    if (!q) return true
    const hay = `${m.home} ${m.away} ${m.tournament}`.toLowerCase()
    return hay.includes(q)
  })
})

const condFilterActive = computed(() => filterGroupId.value !== 'all'
  || filterPm.value !== 'all'
  || filterGapMin.value !== 'all'
  || filterRankDiffMax.value !== 'all'
  || filterStrongRankMax.value !== 'all')

const totalPages = computed(() => Math.max(1, Math.ceil(filteredMatches.value.length / pageSize.value)))

const pagedMatches = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredMatches.value.slice(start, start + pageSize.value)
})

const summaryText = computed(() => {
  const c = phaseCounts.value
  const hit = filteredMatches.value.length
  const base = `盘前 ${c.prematch} · 盘中 ${c.inplay} · 盘后 ${c.settled}`
  return condFilterActive.value || filterTour.value !== 'all' || filterQ.value.trim() || filterPhase.value !== 'all'
    ? `${base} · 筛后 ${hit}`
    : base
})

function groupOptionLabel(bucket, g, index) {
  const phase = PHASE_OPTS.find((p) => p.id === bucket)?.label || bucket
  const name = String(g?.name || '').trim() || `条件组 ${index + 1}`
  return `${phase} · ${name}`
}

async function loadConditionGroups() {
  try {
    const cfg = await api.fetchTennisEngines()
    const buckets = cfg?.condition?.buckets || {}
    const opts = []
    for (const bucket of ['prematch', 'inplay', 'settled']) {
      const groups = buckets[bucket]?.groups
      if (!Array.isArray(groups)) continue
      groups.forEach((g, index) => {
        opts.push({
          id: `${bucket}:${index}`,
          bucket,
          label: groupOptionLabel(bucket, g, index),
          rules: { ...g },
        })
      })
    }
    conditionGroupOptions.value = opts
  } catch (_) {
    conditionGroupOptions.value = []
  }
}

function resetCondFilters() {
  filterGroupId.value = 'all'
  filterPm.value = 'all'
  filterGapMin.value = 'all'
  filterRankDiffMax.value = 'all'
  filterStrongRankMax.value = 'all'
  page.value = 1
  editingId.value = ''
  editForm.value = null
}

function flash(msg, isErr = false) {
  if (isErr) {
    error.value = msg
    notice.value = ''
  } else {
    notice.value = msg
    error.value = ''
    setTimeout(() => {
      if (notice.value === msg) notice.value = ''
    }, 2500)
  }
}

function setPhaseFilter(id) {
  filterPhase.value = id
  page.value = 1
  editingId.value = ''
  editForm.value = null
}

function goPage(p) {
  const n = Math.min(totalPages.value, Math.max(1, Number(p) || 1))
  page.value = n
  editingId.value = ''
  editForm.value = null
}

function toggleEdit(id) {
  const sid = String(id)
  if (editingId.value === sid) {
    editingId.value = ''
    editForm.value = null
    return
  }
  const m = matches.value.find((x) => String(x.id) === sid)
  if (m) {
    const draft = cloneDraft(m)
    drafts.value = { ...drafts.value, [sid]: draft }
    editForm.value = cloneDraft(m)
  } else {
    editForm.value = null
  }
  editingId.value = sid
}

function cancelEdit() {
  const sid = editingId.value
  if (sid) {
    const m = matches.value.find((x) => String(x.id) === sid)
    if (m) drafts.value = { ...drafts.value, [sid]: cloneDraft(m) }
  }
  editingId.value = ''
  editForm.value = null
}

async function loadDays() {
  const r = await api.fetchDocks500Days()
  days.value = Array.isArray(r?.days) ? r.days : []
  let prefer = String(props.initialDate || '').trim()
  if (!prefer) {
    try {
      prefer = sessionStorage.getItem('tennis_docks_editor_date') || ''
    } catch (_) { /* ignore */ }
  }
  if (prefer && days.value.some((d) => d.date === prefer)) {
    selectedDate.value = prefer
  } else if (r?.date && days.value.some((d) => d.date === r.date)) {
    selectedDate.value = r.date
  } else {
    selectedDate.value = days.value[0]?.date || ''
  }
}

async function loadDay() {
  if (!selectedDate.value) {
    matches.value = []
    return
  }
  loading.value = true
  error.value = ''
  editingId.value = ''
  editForm.value = null
  page.value = 1
  try {
    const r = await api.fetchDocks500Day(selectedDate.value)
    phasesLocked.value = !!r.phasesLocked
    virtualSim.value = r.virtualSim || null
    matches.value = Array.isArray(r.matches) ? r.matches : []
    syncDrafts(matches.value)
    try {
      sessionStorage.setItem('tennis_docks_editor_date', selectedDate.value)
    } catch (_) { /* ignore */ }
  } catch (e) {
    flash(e?.response?.data?.error || e?.message || '加载失败', true)
    matches.value = []
  } finally {
    loading.value = false
  }
}

async function saveRow(id) {
  const sid = String(id)
  const draft = editForm.value && String(editForm.value.id) === sid
    ? editForm.value
    : drafts.value[sid]
  if (!draft || !selectedDate.value) return
  savingId.value = sid
  error.value = ''
  try {
    const patch = {
      phase: draft.phase,
      home: draft.home,
      away: draft.away,
      homeRank: draft.homeRank === '' ? undefined : Number(draft.homeRank),
      awayRank: draft.awayRank === '' ? undefined : Number(draft.awayRank),
      homeBest: draft.homeBest === '' ? undefined : Number(draft.homeBest),
      awayBest: draft.awayBest === '' ? undefined : Number(draft.awayBest),
      scoreText: joinScoreSets(draft.scoreSets),
      finalScoreText: joinScoreSets(draft.finalScoreSets),
      tournament: draft.tournament,
      tour: draft.tour,
    }
    const url = String(draft.polymarketUrl || '').trim()
    const pmHomeRaw = draft.pmHome === '' || draft.pmHome == null ? null : Number(draft.pmHome)
    const pmAwayRaw = draft.pmAway === '' || draft.pmAway == null ? null : Number(draft.pmAway)
    const hasPm = (pmHomeRaw != null && Number.isFinite(pmHomeRaw)) || (pmAwayRaw != null && Number.isFinite(pmAwayRaw))
    if (hasPm) {
      patch.pmHome = pmHomeRaw != null && Number.isFinite(pmHomeRaw) ? pmHomeRaw : null
      patch.pmAway = pmAwayRaw != null && Number.isFinite(pmAwayRaw) ? pmAwayRaw : null
      if (url) patch.polymarketUrl = url
    } else {
      patch.polymarketUrl = url
      patch.pmHome = null
      patch.pmAway = null
    }
    const ts = parseLocalTs(draft.startLocal)
    if (ts != null) patch.startTimestamp = ts
    const r = await api.patchDocks500Match(selectedDate.value, sid, patch)
    phasesLocked.value = true
    if (r.virtualSim) virtualSim.value = r.virtualSim
    if (r.match) {
      const idx = matches.value.findIndex((m) => String(m.id) === sid)
      if (idx >= 0) {
        const next = [...matches.value]
        next[idx] = { ...next[idx], ...r.match }
        matches.value = next
        drafts.value = { ...drafts.value, [sid]: cloneDraft(r.match) }
      }
      if (r.match.pmHome == null && r.match.pmAway == null && hasPm) {
        flash('保存成功但未返回 PM ¢，请刷新日期或重启 API 后再试', true)
      }
    } else {
      await loadDay()
    }
    editingId.value = ''
    editForm.value = null
    flash('已保存（阶段已锁定）')
  } catch (e) {
    flash(e?.response?.data?.error || e?.message || '保存失败', true)
  } finally {
    savingId.value = ''
  }
}

async function onApplyRedis() {
  if (!selectedDate.value || applying.value) return
  applying.value = true
  error.value = ''
  try {
    const r = await api.applyDocks500Day(selectedDate.value)
    const split = r.split || r.sim
    flash(
      r.message
        || `已写 Redis · 盘前${split?.prematch ?? '?'} / 盘中${split?.inplay ?? '?'} / 盘后${split?.settled ?? '?'}`,
    )
  } catch (e) {
    flash(e?.response?.data?.error || e?.message || '写 Redis 失败', true)
  } finally {
    applying.value = false
  }
}

async function onUnlockResim() {
  if (!selectedDate.value || resimming.value) return
  if (!window.confirm('将清除手动锁定并按规则重新拆盘前/盘中/盘后，确定？')) return
  resimming.value = true
  error.value = ''
  try {
    const r = await api.unlockResimDocks500Day(selectedDate.value)
    phasesLocked.value = !!r.phasesLocked
    virtualSim.value = r.virtualSim || null
    matches.value = Array.isArray(r.matches) ? r.matches : []
    syncDrafts(matches.value)
    editingId.value = ''
    editForm.value = null
    page.value = 1
    flash('已重新自动拆桶')
  } catch (e) {
    flash(e?.response?.data?.error || e?.message || '拆桶失败', true)
  } finally {
    resimming.value = false
  }
}

async function refreshDaysMeta() {
  try {
    const r = await api.fetchDocks500Days()
    days.value = Array.isArray(r?.days) ? r.days : days.value
  } catch (_) { /* ignore */ }
}

async function onClearDay() {
  if (!selectedDate.value || clearing.value) return
  if (!window.confirm(`清空 ${selectedDate.value} 的全部场次？可再手动新增。`)) return
  clearing.value = true
  error.value = ''
  try {
    const r = await api.clearDocks500Day(selectedDate.value)
    phasesLocked.value = true
    virtualSim.value = r.virtualSim || null
    matches.value = []
    syncDrafts([])
    editingId.value = ''
    editForm.value = null
    showAddForm.value = true
    page.value = 1
    await refreshDaysMeta()
    flash('已清空，可新增场次')
  } catch (e) {
    flash(e?.response?.data?.error || e?.message || '清空失败', true)
  } finally {
    clearing.value = false
  }
}

async function onAddMatch() {
  if (!selectedDate.value || adding.value) return
  const f = addForm.value
  if (!String(f.home || '').trim() || !String(f.away || '').trim()) {
    flash('请填写主客球员', true)
    return
  }
  adding.value = true
  error.value = ''
  try {
    const body = {
      phase: f.phase,
      tour: f.tour,
      tournament: String(f.tournament || '').trim() || '自定义赛事',
      home: String(f.home).trim(),
      away: String(f.away).trim(),
      homeRank: f.homeRank === '' ? undefined : Number(f.homeRank),
      awayRank: f.awayRank === '' ? undefined : Number(f.awayRank),
      homeBest: f.homeBest === '' ? undefined : Number(f.homeBest),
      awayBest: f.awayBest === '' ? undefined : Number(f.awayBest),
      scoreText: joinScoreSets(f.scoreSets),
      finalScoreText: joinScoreSets(f.finalScoreSets),
      polymarketUrl: f.polymarketUrl,
      pmHome: f.pmHome === '' ? undefined : Number(f.pmHome),
      pmAway: f.pmAway === '' ? undefined : Number(f.pmAway),
    }
    const r = await api.addDocks500Match(selectedDate.value, body)
    phasesLocked.value = true
    if (r.virtualSim) virtualSim.value = r.virtualSim
    if (Array.isArray(r.matches)) {
      matches.value = r.matches
      syncDrafts(r.matches)
    } else {
      await loadDay()
    }
    addForm.value = emptyAddForm()
    showAddForm.value = false
    editingId.value = r.eventId ? String(r.eventId) : ''
    if (editingId.value && r.match) {
      const draft = cloneDraft(r.match)
      drafts.value = { ...drafts.value, [editingId.value]: draft }
      editForm.value = cloneDraft(r.match)
    } else {
      editForm.value = null
    }
    await refreshDaysMeta()
    flash('已新增场次')
  } catch (e) {
    flash(e?.response?.data?.error || e?.message || '新增失败', true)
  } finally {
    adding.value = false
  }
}

watch(selectedDate, () => {
  loadDay()
  showAddForm.value = false
  addForm.value = emptyAddForm()
})

watch([filterTour, filterQ, pageSize, filterPm, filterGapMin, filterRankDiffMax, filterStrongRankMax, filterGroupId], () => {
  page.value = 1
  editingId.value = ''
  editForm.value = null
})

watch(filteredMatches, (list) => {
  if (page.value > Math.max(1, Math.ceil(list.length / pageSize.value))) {
    page.value = 1
  }
})

onMounted(async () => {
  loading.value = true
  try {
    await Promise.all([loadDays(), loadConditionGroups()])
    await loadDay()
  } catch (e) {
    flash(e?.response?.data?.error || e?.message || '初始化失败', true)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="docks-editor" :class="{ standalone }">
    <header class="de-toolbar">
      <div class="de-toolbar-left">
        <h2 class="de-title">虚拟日场次</h2>
        <p class="de-sub">
          {{ summaryText }}
          <span v-if="phasesLocked" class="de-lock">已锁定</span>
          <span v-else class="de-lock off">自动拆桶预览</span>
        </p>
      </div>
      <div class="de-toolbar-right">
        <label class="de-field">
          <span>虚拟日</span>
          <select v-model="selectedDate" :disabled="loading || !days.length">
            <option v-for="d in days" :key="d.date" :value="d.date">
              {{ d.date }} · {{ d.matchCount || 0 }}场{{ d.phasesLocked ? ' ·锁' : '' }}
            </option>
          </select>
        </label>
        <button type="button" class="chip-btn" :disabled="loading || resimming || !selectedDate" @click="onUnlockResim">
          {{ resimming ? '拆桶中…' : '重新自动拆桶' }}
        </button>
        <button type="button" class="chip-btn danger" :disabled="loading || clearing || !selectedDate" @click="onClearDay">
          {{ clearing ? '清空中…' : '清空数据' }}
        </button>
        <button
          type="button"
          class="chip-btn"
          :class="{ active: showAddForm }"
          :disabled="loading || !selectedDate"
          @click="showAddForm = !showAddForm"
        >
          {{ showAddForm ? '收起新增' : '新增赛事' }}
        </button>
        <button type="button" class="chip-btn active" :disabled="loading || applying || !selectedDate" @click="onApplyRedis">
          {{ applying ? '写入中…' : '写回 Redis' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="de-msg err">{{ error }}</p>
    <p v-if="notice" class="de-msg ok">{{ notice }}</p>

    <section v-if="showAddForm" class="de-add">
      <div class="de-add-title">新增场次</div>
      <div class="de-add-grid">
        <label>
          <span>阶段</span>
          <select v-model="addForm.phase" :disabled="adding">
            <option v-for="p in PHASE_OPTS" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
        </label>
        <label>
          <span>巡回</span>
          <select v-model="addForm.tour" :disabled="adding">
            <option value="ATP">ATP</option>
            <option value="WTA">WTA</option>
          </select>
        </label>
        <label class="span2">
          <span>赛事名</span>
          <input v-model="addForm.tournament" type="text" placeholder="自定义赛事" :disabled="adding">
        </label>
        <label>
          <span>主</span>
          <input v-model="addForm.home" type="text" placeholder="主场球员" :disabled="adding">
        </label>
        <label>
          <span>客</span>
          <input v-model="addForm.away" type="text" placeholder="客场球员" :disabled="adding">
        </label>
        <label>
          <span>主现排</span>
          <input v-model="addForm.homeRank" type="number" min="1" :disabled="adding">
        </label>
        <label>
          <span>客现排</span>
          <input v-model="addForm.awayRank" type="number" min="1" :disabled="adding">
        </label>
        <label>
          <span>主巅峰</span>
          <input v-model="addForm.homeBest" type="number" min="1" :disabled="adding">
        </label>
        <label>
          <span>客巅峰</span>
          <input v-model="addForm.awayBest" type="number" min="1" :disabled="adding">
        </label>
        <label class="span2">
          <span>Polymarket（可选）</span>
          <input v-model="addForm.polymarketUrl" type="text" placeholder="空=无PM" :disabled="adding">
        </label>
        <label>
          <span>主 PM ¢</span>
          <input v-model="addForm.pmHome" type="number" min="1" max="99" placeholder="如 62" :disabled="adding">
        </label>
        <label>
          <span>客 PM ¢</span>
          <input v-model="addForm.pmAway" type="number" min="1" max="99" placeholder="如 38" :disabled="adding">
        </label>
      </div>
      <div class="de-score-block">
        <div class="de-score-head">
          <span>当前比分（按盘，可选）</span>
          <button type="button" class="chip-btn" :disabled="adding" @click="addScoreSet(addForm, 'scoreSets')">+ 盘</button>
        </div>
        <div class="de-score-sets">
          <div v-for="(s, si) in addForm.scoreSets" :key="'add-cur-' + si" class="de-score-set">
            <span class="de-set-label">第{{ si + 1 }}盘</span>
            <input v-model="s.home" type="number" min="0" max="99" placeholder="主" :disabled="adding">
            <em>-</em>
            <input v-model="s.away" type="number" min="0" max="99" placeholder="客" :disabled="adding">
            <button
              type="button"
              class="de-set-del"
              :disabled="adding || addForm.scoreSets.length <= 1"
              @click="removeScoreSet(addForm, 'scoreSets', si)"
            >×</button>
          </div>
        </div>
      </div>
      <div class="de-score-block">
        <div class="de-score-head">
          <span>完赛比分（按盘，可选）</span>
          <button type="button" class="chip-btn" :disabled="adding" @click="addScoreSet(addForm, 'finalScoreSets')">+ 盘</button>
        </div>
        <div class="de-score-sets">
          <div v-for="(s, si) in addForm.finalScoreSets" :key="'add-fin-' + si" class="de-score-set">
            <span class="de-set-label">第{{ si + 1 }}盘</span>
            <input v-model="s.home" type="number" min="0" max="99" placeholder="主" :disabled="adding">
            <em>-</em>
            <input v-model="s.away" type="number" min="0" max="99" placeholder="客" :disabled="adding">
            <button
              type="button"
              class="de-set-del"
              :disabled="adding || addForm.finalScoreSets.length <= 1"
              @click="removeScoreSet(addForm, 'finalScoreSets', si)"
            >×</button>
          </div>
        </div>
      </div>
      <div class="de-add-foot">
        <button type="button" class="chip-btn" :disabled="adding" @click="showAddForm = false; addForm = emptyAddForm()">取消</button>
        <button type="button" class="chip-btn active" :disabled="adding" @click="onAddMatch">
          {{ adding ? '新增中…' : '确认新增' }}
        </button>
      </div>
    </section>

    <div class="de-cond">
      <div class="de-phases">
        <button
          type="button"
          class="de-phase"
          :class="{ on: filterPhase === 'all' }"
          @click="setPhaseFilter('all')"
        >
          全部 <em>{{ phaseCounts.all }}</em>
        </button>
        <button
          v-for="p in PHASE_OPTS"
          :key="p.id"
          type="button"
          class="de-phase"
          :class="{ on: filterPhase === p.id, [p.id]: true }"
          @click="setPhaseFilter(p.id)"
        >
          {{ p.label }} <em>{{ phaseCounts[p.id] }}</em>
        </button>
      </div>
      <div class="de-cond-right">
        <label class="de-field compact">
          <span>巡回</span>
          <select v-model="filterTour">
            <option value="all">全部</option>
            <option value="ATP">ATP</option>
            <option value="WTA">WTA</option>
          </select>
        </label>
        <label class="de-field compact">
          <span>条件组</span>
          <select v-model="filterGroupId">
            <option value="all">手动条件</option>
            <option v-for="o in conditionGroupOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
        </label>
        <label class="de-field compact">
          <span>PM</span>
          <select v-model="filterPm" :disabled="filterGroupId !== 'all'">
            <option value="all">全部</option>
            <option value="yes">有</option>
            <option value="no">无</option>
          </select>
        </label>
        <label class="de-field compact">
          <span>强现≤</span>
          <select v-model="filterStrongRankMax" :disabled="filterGroupId !== 'all'">
            <option v-for="o in RANK_OPTS" :key="'sr-' + o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label class="de-field compact">
          <span>现差</span>
          <select v-model="filterGapMin" :disabled="filterGroupId !== 'all'">
            <option v-for="o in GAP_OPTS" :key="'gap-' + o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label class="de-field compact">
          <span>排差</span>
          <select v-model="filterRankDiffMax" :disabled="filterGroupId !== 'all'">
            <option v-for="o in DIFF_OPTS" :key="'rd-' + o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label class="de-field compact de-q">
          <span>搜索</span>
          <input v-model="filterQ" type="search" placeholder="球员 / 赛事">
        </label>
        <button
          v-if="condFilterActive"
          type="button"
          class="chip-btn"
          @click="resetCondFilters"
        >清除条件</button>
      </div>
    </div>

    <div v-if="loading" class="de-empty">加载中…</div>
    <div v-else-if="!filteredMatches.length" class="de-empty">无场次</div>
    <div v-else class="de-table-panel">
      <table class="de-table">
        <thead>
          <tr>
            <th class="col-phase">阶段</th>
            <th class="col-tour">巡回</th>
            <th class="col-pair">对阵</th>
            <th class="col-rank">排名</th>
            <th class="col-score">比分</th>
            <th class="col-tourney">赛事</th>
            <th class="col-start">开赛</th>
            <th class="col-pm">PM</th>
            <th class="col-pm-odds">PM主/客¢</th>
            <th class="col-act"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="m in pagedMatches" :key="m.id">
            <tr>
              <td><span class="de-badge" :class="m.phase">{{ phaseLabel(m.phase) }}</span></td>
              <td>{{ m.tour || '-' }}</td>
              <td class="col-pair">
                <span class="pair-line">{{ m.home || '-' }} <em>vs</em> {{ m.away || '-' }}</span>
              </td>
              <td class="mono">#{{ m.homeRank || '-' }}/{{ m.awayRank || '-' }}</td>
              <td class="mono">{{ m.scoreText || m.finalScoreText || '-' }}</td>
              <td class="muted">{{ m.tournament || '-' }}</td>
              <td class="mono muted">{{ fmtTs(m.startTimestamp).replace('T', ' ') || '-' }}</td>
              <td class="col-pm">
                <a v-if="m.polymarketUrl" :href="m.polymarketUrl" target="_blank" rel="noopener" class="pm-link">有</a>
                <span v-else class="muted">-</span>
              </td>
              <td class="col-pm-odds mono">
                <span v-if="fmtPmPair(m)" :title="'主 ' + m.pmHome + '¢ / 客 ' + m.pmAway + '¢'">{{ fmtPmPair(m) }}</span>
                <span v-else class="muted">-</span>
              </td>
              <td class="col-act">
                <button type="button" class="chip-btn" @click="toggleEdit(m.id)">编辑</button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <Teleport to="body">
      <div
        v-if="editingId && editingDraft"
        class="de-modal-mask"
        @click.self="cancelEdit"
      >
        <div class="de-modal-sheet" role="dialog" aria-modal="true" aria-labelledby="de-edit-title">
          <div class="de-modal-head">
            <div class="min-w-0">
              <div id="de-edit-title" class="de-modal-title">编辑场次</div>
              <div class="de-modal-sub truncate">
                {{ editingDraft.home || editingMatch?.home || '—' }}
                vs
                {{ editingDraft.away || editingMatch?.away || '—' }}
              </div>
            </div>
            <button type="button" class="de-modal-x" :disabled="!!savingId" @click="cancelEdit" aria-label="关闭">×</button>
          </div>
          <div class="de-modal-body">
            <div class="de-edit">
              <div class="de-edit-grid">
                <label>
                  <span>阶段</span>
                  <select v-model="editingDraft.phase" :disabled="!!savingId">
                    <option v-for="p in PHASE_OPTS" :key="p.id" :value="p.id">{{ p.label }}</option>
                  </select>
                </label>
                <label>
                  <span>巡回</span>
                  <select v-model="editingDraft.tour" :disabled="!!savingId">
                    <option value="ATP">ATP</option>
                    <option value="WTA">WTA</option>
                  </select>
                </label>
                <label>
                  <span>主</span>
                  <input v-model="editingDraft.home" type="text" :disabled="!!savingId">
                </label>
                <label>
                  <span>客</span>
                  <input v-model="editingDraft.away" type="text" :disabled="!!savingId">
                </label>
                <label>
                  <span>主现排</span>
                  <input v-model="editingDraft.homeRank" type="number" min="1" :disabled="!!savingId">
                </label>
                <label>
                  <span>客现排</span>
                  <input v-model="editingDraft.awayRank" type="number" min="1" :disabled="!!savingId">
                </label>
                <label>
                  <span>主巅峰</span>
                  <input v-model="editingDraft.homeBest" type="number" min="1" :disabled="!!savingId">
                </label>
                <label>
                  <span>客巅峰</span>
                  <input v-model="editingDraft.awayBest" type="number" min="1" :disabled="!!savingId">
                </label>
                <div class="de-score-block span-all">
                  <div class="de-score-head">
                    <span>当前比分（按盘）</span>
                    <button type="button" class="chip-btn" :disabled="!!savingId" @click="addScoreSet(editingDraft, 'scoreSets')">+ 盘</button>
                  </div>
                  <div class="de-score-sets">
                    <div
                      v-for="(s, si) in editingDraft.scoreSets"
                      :key="'cur-' + si"
                      class="de-score-set"
                    >
                      <span class="de-set-label">第{{ si + 1 }}盘</span>
                      <input v-model="s.home" type="number" min="0" max="99" placeholder="主" :disabled="!!savingId">
                      <em>-</em>
                      <input v-model="s.away" type="number" min="0" max="99" placeholder="客" :disabled="!!savingId">
                      <button
                        type="button"
                        class="de-set-del"
                        title="删除此盘"
                        :disabled="!!savingId || editingDraft.scoreSets.length <= 1"
                        @click="removeScoreSet(editingDraft, 'scoreSets', si)"
                      >×</button>
                    </div>
                  </div>
                </div>
                <div class="de-score-block span-all">
                  <div class="de-score-head">
                    <span>完赛比分（按盘）</span>
                    <button type="button" class="chip-btn" :disabled="!!savingId" @click="addScoreSet(editingDraft, 'finalScoreSets')">+ 盘</button>
                  </div>
                  <div class="de-score-sets">
                    <div
                      v-for="(s, si) in editingDraft.finalScoreSets"
                      :key="'fin-' + si"
                      class="de-score-set"
                    >
                      <span class="de-set-label">第{{ si + 1 }}盘</span>
                      <input v-model="s.home" type="number" min="0" max="99" placeholder="主" :disabled="!!savingId">
                      <em>-</em>
                      <input v-model="s.away" type="number" min="0" max="99" placeholder="客" :disabled="!!savingId">
                      <button
                        type="button"
                        class="de-set-del"
                        title="删除此盘"
                        :disabled="!!savingId || editingDraft.finalScoreSets.length <= 1"
                        @click="removeScoreSet(editingDraft, 'finalScoreSets', si)"
                      >×</button>
                    </div>
                  </div>
                </div>
                <label>
                  <span>开赛时间</span>
                  <input v-model="editingDraft.startLocal" type="datetime-local" :disabled="!!savingId">
                </label>
                <label>
                  <span>赛事</span>
                  <input v-model="editingDraft.tournament" type="text" :disabled="!!savingId">
                </label>
                <label class="span2">
                  <span>Polymarket（空=清）</span>
                  <input v-model="editingDraft.polymarketUrl" type="text" placeholder="空=无PM" :disabled="!!savingId">
                </label>
                <label>
                  <span>主 PM ¢</span>
                  <input v-model="editingDraft.pmHome" type="number" min="1" max="99" placeholder="如 62" :disabled="!!savingId">
                </label>
                <label>
                  <span>客 PM ¢</span>
                  <input v-model="editingDraft.pmAway" type="number" min="1" max="99" placeholder="如 38" :disabled="!!savingId">
                </label>
              </div>
            </div>
          </div>
          <div class="de-modal-foot">
            <span class="de-id">id {{ editingId }}</span>
            <div class="de-modal-actions">
              <button type="button" class="chip-btn" :disabled="!!savingId" @click="cancelEdit">取消</button>
              <button
                type="button"
                class="chip-btn active"
                :disabled="savingId === editingId"
                @click="saveRow(editingId)"
              >
                {{ savingId === editingId ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <footer v-if="!loading && filteredMatches.length" class="de-pager">
      <span class="de-pager-info">
        共 {{ filteredMatches.length }} 场 · 第 {{ page }} / {{ totalPages }} 页
      </span>
      <label class="de-field compact">
        <span>每页</span>
        <select v-model.number="pageSize">
          <option :value="10">10</option>
          <option :value="20">20</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
        </select>
      </label>
      <button type="button" class="chip-btn" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
      <button type="button" class="chip-btn" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
    </footer>
  </div>
</template>

<style scoped>
.docks-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  min-height: calc(100vh - 180px);
}
.docks-editor.standalone {
  min-height: 100vh;
  height: 100vh;
  box-sizing: border-box;
  padding: 16px 20px 20px;
  gap: 12px;
  background: #f1f5f9;
  overflow: hidden;
}
.docks-editor.standalone .de-toolbar,
.docks-editor.standalone .de-cond,
.docks-editor.standalone .de-pager {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 16px;
  flex-shrink: 0;
}
.docks-editor.standalone .de-title {
  font-size: 1.35rem;
}
.docks-editor.standalone .de-table-panel {
  flex: 1;
  min-height: 0;
  border-radius: 10px;
  overflow: auto;
}
.docks-editor.standalone .de-table {
  table-layout: auto;
  font-size: 0.9rem;
}
.docks-editor.standalone .de-table thead th {
  top: 0;
}
.docks-editor.standalone .de-table tbody td {
  white-space: normal;
  overflow: visible;
  text-overflow: unset;
  padding: 12px 14px;
}
.docks-editor.standalone .col-pair,
.docks-editor.standalone .col-tourney {
  width: auto;
}
.docks-editor.standalone .de-edit-grid {
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}
.de-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 16px;
  padding-bottom: 4px;
}
.de-toolbar-left { min-width: 0; }
.de-toolbar-right {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}
.de-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.de-sub {
  margin: 4px 0 0;
  font-size: 0.85rem;
  color: #64748b;
}
.de-lock {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  background: #dcfce7;
  color: #166534;
}
.de-lock.off {
  background: #f1f5f9;
  color: #64748b;
}
.de-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.75rem;
  color: #64748b;
}
.de-field.compact {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.de-field select,
.de-field input {
  padding: 6px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  font-size: 0.85rem;
  color: #0f172a;
  min-width: 0;
}
.de-toolbar-right .de-field select { min-width: 220px; }
.de-msg { margin: 0; font-size: 0.85rem; }
.de-msg.err { color: #b91c1c; }
.de-msg.ok { color: #166534; }

.de-add {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
}
.de-add-title {
  font-size: 0.95rem;
  font-weight: 650;
  color: #0f172a;
}
.de-add-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 10px 12px;
}
.de-add-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.72rem;
  color: #64748b;
}
.de-add-grid label.span2 { grid-column: span 2; }
.de-add-grid input,
.de-add-grid select {
  padding: 6px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  font-size: 0.85rem;
  color: #0f172a;
}
.de-add-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.de-cond {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
}
.de-phases {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.de-cond-right {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.de-phase {
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 0.85rem;
  cursor: pointer;
  color: #334155;
}
.de-phase em {
  font-style: normal;
  margin-left: 4px;
  color: #94a3b8;
}
.de-phase.on {
  background: #0f172a;
  border-color: #0f172a;
  color: #fff;
}
.de-phase.on em { color: #cbd5e1; }
.de-phase.prematch.on { background: #0369a1; border-color: #0369a1; }
.de-phase.inplay.on { background: #b45309; border-color: #b45309; }
.de-phase.settled.on { background: #475569; border-color: #475569; }
.de-q input { min-width: 180px; }

.de-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: #94a3b8;
  border: 1px dashed #e2e8f0;
  border-radius: 12px;
  background: #fff;
}

.de-table-panel {
  flex: 1;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
}
.de-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.85rem;
  table-layout: fixed;
}
.de-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 10px 12px;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  color: #475569;
  font-weight: 600;
  white-space: nowrap;
}
.de-table tbody td {
  padding: 10px 12px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.de-table tbody tr.open > td {
  background: #f8fafc;
}
.de-table tbody tr:hover > td {
  background: #fafbfc;
}
.col-phase { width: 72px; }
.col-tour { width: 56px; }
.col-pair { width: 28%; }
.col-rank { width: 96px; }
.col-score { width: 110px; }
.col-tourney { width: 14%; }
.col-start { width: 140px; }
.col-pm { width: 48px; text-align: center; }
.col-pm-odds { width: 88px; text-align: center; white-space: nowrap; }
.col-act { width: 76px; text-align: right; }
.pair-line em {
  font-style: normal;
  margin: 0 6px;
  color: #94a3b8;
}
.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; }
.muted { color: #94a3b8; }
.pm-link {
  color: #0369a1;
  text-decoration: none;
  font-weight: 600;
}
.pm-link:hover { text-decoration: underline; }

.de-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  background: #f1f5f9;
  color: #475569;
}
.de-badge.prematch { background: #e0f2fe; color: #0369a1; }
.de-badge.inplay { background: #ffedd5; color: #c2410c; }
.de-badge.settled { background: #e2e8f0; color: #475569; }

.de-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 24px 12px;
  overflow-y: auto;
}
.de-modal-sheet {
  width: min(920px, 100%);
  margin: 12px auto 40px;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
  display: flex;
  flex-direction: column;
  max-height: min(92vh, 900px);
  overflow: hidden;
}
.de-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.de-modal-title {
  font-size: 1.05rem;
  font-weight: 700;
  color: #0f172a;
}
.de-modal-sub {
  margin-top: 4px;
  font-size: 0.8rem;
  color: #64748b;
}
.de-modal-x {
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}
.de-modal-x:hover { color: #475569; }
.de-modal-body {
  padding: 4px 4px 8px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.de-modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px 16px;
  border-top: 1px solid #e2e8f0;
  background: #f8fafc;
  flex-shrink: 0;
}
.de-modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.de-edit {
  padding: 14px 16px 16px;
}
.de-edit-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 10px 12px;
}
.de-edit-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.72rem;
  color: #64748b;
}
.de-edit-grid label.span2 { grid-column: span 2; }
.de-edit-grid .span-all { grid-column: 1 / -1; }
.de-score-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}
.de-score-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.72rem;
  color: #64748b;
}
.de-score-sets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.de-score-set {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}
.de-set-label {
  font-size: 0.72rem;
  color: #64748b;
  white-space: nowrap;
}
.de-score-set input {
  width: 52px;
  padding: 4px 6px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  font-size: 0.85rem;
  color: #0f172a;
  text-align: center;
}
.de-score-set em {
  font-style: normal;
  color: #94a3b8;
}
.de-set-del {
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0 2px;
}
.de-set-del:hover:not(:disabled) { color: #b91c1c; }
.de-set-del:disabled { opacity: 0.35; cursor: not-allowed; }
.de-edit-grid input,
.de-edit-grid select {
  padding: 6px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  font-size: 0.85rem;
  color: #0f172a;
}
.de-id {
  margin-right: auto;
  font-size: 0.75rem;
  color: #94a3b8;
}

.de-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
.de-pager-info {
  font-size: 0.85rem;
  color: #64748b;
  margin-right: auto;
}

.chip-btn {
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
}
.chip-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.chip-btn.active {
  background: #0f172a;
  border-color: #0f172a;
  color: #fff;
}
.chip-btn.danger {
  border-color: #fecaca;
  color: #b91c1c;
  background: #fff;
}
.chip-btn.danger:hover:not(:disabled) {
  background: #fef2f2;
}

@media (max-width: 1100px) {
  .de-edit-grid,
  .de-add-grid {
    grid-template-columns: repeat(3, minmax(120px, 1fr));
  }
}
</style>
