import { computed, ref } from 'vue'
import * as api from '../api'
import { normalizeInplayBettingEntry } from '../utils/tennisListFilters'

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

/** 旧版默认占位（BO3+第3盘+局差2）会让「只改了 PM」永远不触发；加载时拆掉 */
function softenLegacyStopRule(r) {
  const o = { ...(r || {}) }
  const fmt = String(o.stopFormat || '').toLowerCase()
  const setIdx = o.stopSetIndex
  const lead = o.stopGameLead
  const looksLegacyDefault = fmt === 'bo3'
    && (Number(setIdx) === 3 || setIdx === 3)
    && (Number(lead) === 2 || lead === 2)
  if (looksLegacyDefault) {
    o.stopFormat = 'any'
    o.stopSetIndex = 'all'
    o.stopGameLead = 'all'
  }
  return o
}

function emptyBettingGroup(kind = 'inplay') {
  const isInplay = kind === 'inplay'
  return {
    id: `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    joinPrev: 'or',
    amountUsd: 1,
    stopEnabled: isInplay,
    stopRules: isInplay ? [emptyStopRule()] : [],
  }
}

function ensureStopRules(g) {
  if (Array.isArray(g?.stopRules)) return g.stopRules
  return [emptyStopRule()]
}

function parseRuleNum(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return 'all'
  const n = Number(s)
  return Number.isFinite(n) ? n : 'all'
}

/**
 * 盘前/盘中投注规则弹窗
 * @param {object} opts
 */
export function useTennisBettingRules({
  props,
  isPrematchMode,
  isInplayMode,
  batchAmountUsd,
  getSyncListAutoBetFromBucket,
  getLibraryGroups,
  getConditionGroups,
  getLoadProductSelect,
  clearSelectNotices,
  getShowAdminEngineButtons,
}) {
  const bettingModalOpen = ref(false)
  const betRulesLoading = ref(false)
  const betRulesSaving = ref(false)
  const betRulesError = ref('')
  const betRulesNotice = ref('')
  const bettingBucketOn = ref(false)
  const bettingSimulateOn = ref(false)
  const bettingGroups = ref([])
  const bettingEntry = ref(normalizeInplayBettingEntry(null))
  const bettingEntryNorm = computed(() => normalizeInplayBettingEntry(bettingEntry.value))

  const INPLAY_AUTO_RULES_TEXT = computed(() => {
    const e = bettingEntryNorm.value
    const pm = e.pmCentsMax === 'all' || e.pmCentsMax == null ? 'PM不限' : `PM<${e.pmCentsMax}¢`
    let first = '盘差不限'
    if (e.setGapMin != null && e.setGapMin !== '' && e.setGapMin !== 'all') {
      first = `第${e.wonSetIndex || 1}盘·盘差>${e.setGapMin}`
    } else if (e.requireWonFirstSet) {
      first = `须赢第${e.wonSetIndex || 1}盘`
    }
    return `买入：${first} · ${pm}｜卖出见投注设置`
  })

  const canEditBettingRules = computed(
    () => props.canEditRules && (isPrematchMode.value || isInplayMode.value),
  )
  const showAdminEngineButtons = computed(
    () => props.canEditRules && (isPrematchMode.value || isInplayMode.value),
  )
  const bettingBucketKey = computed(() => (isInplayMode.value ? 'inplay' : 'prematch'))
  const bettingBucketLabel = computed(() => (isInplayMode.value ? '比赛中' : '未开赛'))

  const betRulesSummary = computed(() => {
    const n = bettingGroups.value.length
    const stops = bettingGroups.value.reduce((sum, g) => sum + (g.stopEnabled === false ? 0 : ensureStopRules(g).length), 0)
    const stake = null
    const lib = getLibraryGroups?.() || []
    const cond = getConditionGroups?.() || []
    const condN = isInplayMode.value ? (lib.length || cond.length) : 0
    return [
      `${bettingBucketLabel.value}${bettingBucketOn.value ? '开' : '关'}`,
      isInplayMode.value ? null : (bettingSimulateOn.value ? '模拟' : '实盘'),
      isInplayMode.value ? (condN ? `条件${condN}组` : '条件未配') : null,
      isInplayMode.value ? `${n} 条件组` : `${n} 止损组`,
      isInplayMode.value ? `条件${stops}条` : `止损${stops}条`,
    ].filter(Boolean).join(' · ')
  })

  async function loadBettingRules() {
    if (!canEditBettingRules.value) return
    betRulesLoading.value = true
    betRulesError.value = ''
    try {
      const cfg = await api.fetchTennisEngines()
      const key = bettingBucketKey.value
      const bucket = cfg?.betting?.buckets?.[key] || {}
      bettingBucketOn.value = !!bucket.enabled
      bettingSimulateOn.value = !!bucket.simulate
      if (key === 'inplay') {
        bettingEntry.value = normalizeInplayBettingEntry(bucket.entry)
      }
      const groups = Array.isArray(bucket.groups) ? bucket.groups : []
      bettingGroups.value = groups.length
        ? groups.map((g) => ({
            ...emptyBettingGroup(key),
            ...g,
            amountUsd: Number(g.amountUsd) >= 1 ? Number(g.amountUsd) : 1,
            stopRules: ensureStopRules(g).map((r) => softenLegacyStopRule({ ...emptyStopRule(), ...r })),
          }))
        : [emptyBettingGroup(key)]
      // 列表批量/自动投注金额独立默认 1 元，不跟引擎投注组 amountUsd 联动
      await getSyncListAutoBetFromBucket()({ fromSave: false })
    } catch (e) {
      betRulesError.value = e?.response?.data?.error || e?.message || '加载投注止损失败'
    } finally {
      betRulesLoading.value = false
    }
  }

  function setBettingEntryField(key, raw) {
    const e = { ...normalizeInplayBettingEntry(bettingEntry.value) }
    if (key === 'requireWonFirstSet') e.requireWonFirstSet = !!raw
    else if (key === 'wonSetIndex') {
      const n = Number(raw)
      e.wonSetIndex = Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 1
    } else if (key === 'setGapMin') {
      const s = String(raw ?? '').trim()
      if (s === '' || s === 'all') {
        e.setGapMin = 'all'
        e.requireWonFirstSet = false
      } else {
        const n = Number(s)
        e.setGapMin = Number.isFinite(n) ? n : 'all'
        e.requireWonFirstSet = e.setGapMin !== 'all'
      }
    } else if (key === 'firstSetExcludeEnabled') e.firstSetExcludeEnabled = !!raw
    else if (key === 'firstSetExcludeScore') {
      const s = String(raw ?? '').trim().slice(0, 12)
      e.firstSetExcludeScore = s || '7:5'
    } else if (key === 'pmCentsMax') {
      const s = String(raw ?? '').trim()
      e.pmCentsMax = s === '' ? 'all' : (Number.isFinite(Number(s)) ? Number(s) : 'all')
    }
    bettingEntry.value = e
  }

  function setBettingGroupField(gi, key, raw) {
    const groups = [...bettingGroups.value]
    const g = { ...groups[gi] }
    if (key === 'joinPrev') g[key] = raw === 'and' ? 'and' : 'or'
    else if (key === 'name') g[key] = String(raw || '').slice(0, 40)
    else if (key === 'stopEnabled') g[key] = !!raw
    else if (key === 'amountUsd') {
      const n = Number(raw)
      g[key] = Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : 1
    }
    else g[key] = raw
    if (!Array.isArray(g.stopRules)) g.stopRules = [emptyStopRule()]
    if (key === 'stopEnabled' && g.stopEnabled && g.stopRules.length === 0) {
      g.stopRules = [emptyStopRule()]
    }
    groups[gi] = g
    bettingGroups.value = groups
  }

  function setStopRuleField(gi, si, key, raw) {
    const groups = [...bettingGroups.value]
    const g = { ...groups[gi] }
    const rules = [...ensureStopRules(g)]
    const r = { ...emptyStopRule(), ...rules[si] }
    if (['stopStrongSets', 'stopWeakSets', 'stopWeakGamesMin', 'stopPmCentsMax'].includes(key)) {
      r[key] = parseRuleNum(raw)
    } else if (key === 'stopGameLead' || key === 'stopSetIndex') {
      const s = String(raw ?? '').trim()
      if (!s) r[key] = 'all'
      else {
        const n = Number(s)
        if (key === 'stopSetIndex') r[key] = Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 'all'
        else r[key] = Number.isFinite(n) ? n : 'all'
      }
    } else if (key === 'joinPrev') {
      r[key] = raw === 'and' ? 'and' : 'or'
    } else if (key === 'name') {
      r[key] = String(raw || '').slice(0, 40)
    } else {
      r[key] = raw
    }
    rules[si] = r
    g.stopRules = rules
    groups[gi] = g
    bettingGroups.value = groups
  }

  function addBettingGroup() {
    bettingGroups.value = [
      ...bettingGroups.value,
      { ...emptyBettingGroup(bettingBucketKey.value), joinPrev: 'or' },
    ]
  }

  function removeBettingGroup(gi) {
    const next = bettingGroups.value.filter((_, i) => i !== gi)
    bettingGroups.value = next.length ? next : [emptyBettingGroup(bettingBucketKey.value)]
  }

  function addStopRule(gi) {
    const groups = [...bettingGroups.value]
    const g = { ...groups[gi] }
    const prev = Array.isArray(g.stopRules) ? g.stopRules : []
    g.stopRules = [...prev, emptyStopRule()]
    g.stopEnabled = true
    groups[gi] = g
    bettingGroups.value = groups
  }

  function removeStopRule(gi, si) {
    const groups = [...bettingGroups.value]
    const g = { ...groups[gi] }
    const rules = ensureStopRules(g).filter((_, i) => i !== si)
    g.stopRules = rules.length ? rules : [emptyStopRule()]
    groups[gi] = g
    bettingGroups.value = groups
  }

  async function saveBettingRules() {
    if (!canEditBettingRules.value || betRulesSaving.value) return
    betRulesSaving.value = true
    betRulesError.value = ''
    betRulesNotice.value = ''
    const key = bettingBucketKey.value
    try {
      await api.updateTennisEngines({
        betting: {
          enabled: true,
          buckets: {
            [key]: {
              enabled: !!bettingBucketOn.value,
              simulate: !!bettingSimulateOn.value,
              ...(key === 'inplay' ? { entry: normalizeInplayBettingEntry(bettingEntry.value) } : {}),
              groups: bettingGroups.value.map((g) => ({
                ...emptyBettingGroup(key),
                ...g,
                amountUsd: Number(g.amountUsd) >= 1 ? Math.round(Number(g.amountUsd) * 100) / 100 : 1,
                stopRules: ensureStopRules(g).map((r) => softenLegacyStopRule({ ...emptyStopRule(), ...r })),
              })),
            },
          },
        },
      })
      betRulesNotice.value = '保存成功'
      void getSyncListAutoBetFromBucket()({ fromSave: true })
      setTimeout(() => { betRulesNotice.value = '' }, 2500)
    } catch (e) {
      betRulesError.value = `保存失败：${e?.response?.data?.error || e?.message || '请重试'}`
    } finally {
      betRulesSaving.value = false
    }
  }

  async function openBettingModal() {
    const show = getShowAdminEngineButtons ? getShowAdminEngineButtons() : showAdminEngineButtons.value
    if (!show) return
    clearSelectNotices?.()
    betRulesNotice.value = ''
    betRulesError.value = ''
    // 先开弹窗，规则后台加载（弹窗内有 loading 文案）
    bettingModalOpen.value = true
    if (isPrematchMode.value || isInplayMode.value) {
      void (async () => {
        await loadBettingRules()
        await getLoadProductSelect()?.()
      })()
    }
  }

  return {
    emptyStopRule,
    emptyBettingGroup,
    ensureStopRules,
    bettingModalOpen,
    betRulesLoading,
    betRulesSaving,
    betRulesError,
    betRulesNotice,
    bettingBucketOn,
    bettingSimulateOn,
    bettingGroups,
    bettingEntry,
    bettingEntryNorm,
    INPLAY_AUTO_RULES_TEXT,
    canEditBettingRules,
    showAdminEngineButtons,
    bettingBucketKey,
    bettingBucketLabel,
    betRulesSummary,
    loadBettingRules,
    setBettingEntryField,
    setBettingGroupField,
    setStopRuleField,
    addBettingGroup,
    removeBettingGroup,
    addStopRule,
    removeStopRule,
    saveBettingRules,
    openBettingModal,
  }
}
