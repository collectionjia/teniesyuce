import { computed, ref } from 'vue'
import * as api from '../api'

function emptyConditionGroup() {
  return {
    id: `cg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    joinPrev: 'or',
    linkPrematch: false,
    tour: 'all',
    pm: 'all',
    gapMin: 'all',
    rankDiffMin: 'all',
    rankDiffMax: 'all',
    strongRankMax: 'all',
    strongRankGt: 'all',
    strongRankLt: 'all',
    requireWonFirstSet: false,
    firstSetExcludeEnabled: false,
    firstSetExcludeScore: '7:5',
  }
}

function parseRuleNum(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return 'all'
  const n = Number(s)
  return Number.isFinite(n) ? n : 'all'
}

/**
 * 盘前/盘中条件规则弹窗 + 产品条件挂载
 * @param {{ props: object, isPrematchMode: import('vue').Ref|import('vue').ComputedRef, isInplayMode: import('vue').Ref|import('vue').ComputedRef, getLoadOnce: () => Function, getShowAdminEngineButtons?: () => boolean }} opts
 */
export function useTennisConditionRules({
  props,
  isPrematchMode,
  isInplayMode,
  isMixMode,
  getLoadOnce,
  getShowAdminEngineButtons,
}) {
  const rulesLoading = ref(false)
  const rulesSaving = ref(false)
  const rulesError = ref('')
  const rulesNotice = ref('')
  const conditionBucketOn = ref(false)
  const conditionGroups = ref([])
  const conditionModalOpen = ref(false)

  const selectLoading = ref(false)
  const selectSaving = ref(false)
  const selectError = ref('')
  const selectNotice = ref('')
  const libraryGroups = ref([])
  const productSnapshot = ref(null)
  const productSelectCond = ref([])
  const productSelectBet = ref([])

  const isConditionBoard = computed(
    () => isPrematchMode.value || isInplayMode.value || !!isMixMode?.value,
  )
  const canEditConditionRules = computed(
    () => props.canEditRules && isConditionBoard.value,
  )
  const conditionBucketKey = computed(() => (isInplayMode.value ? 'inplay' : 'prematch'))
  const conditionBucketLabel = computed(() => (isInplayMode.value ? '比赛中' : '未开赛'))
  const canEditProductSelect = computed(
    () => props.canEditRules && props.productId != null && props.productId !== '' && isConditionBoard.value,
  )
  const linkedLibraryGroups = computed(() => {
    // mix 与盘前一样：只把勾了「关联未开赛」的组用于列表筛选
    if (!isPrematchMode.value && !isMixMode?.value) return libraryGroups.value
    return libraryGroups.value.filter((g) => g?.linkPrematch === true)
  })
  const needsConditionGroupSelect = computed(() => linkedLibraryGroups.value.length > 0)

  const rulesSummary = computed(() => {
    const n = conditionGroups.value.length
    return [
      conditionBucketOn.value ? `${conditionBucketLabel.value}开` : `${conditionBucketLabel.value}关`,
      `${n} 组`,
    ].join(' · ')
  })

  function conditionGroupLabel(g, index) {
    const n = String(g?.name || '').trim()
    return n || `条件组 ${index + 1}`
  }

  function findLibraryGroup(id) {
    return libraryGroups.value.find((g) => String(g?.id) === String(id)) || null
  }

  function conditionGroupDetailParts(g) {
    if (!g) return ['组不存在或已删除']
    const parts = []
    const tour = g.tour && g.tour !== 'all' ? String(g.tour) : null
    if (tour) parts.push(tour === 'ATP' ? '男' : tour === 'WTA' ? '女' : tour)
    if (g.pm === 'yes') parts.push('有PM')
    else if (g.pm === 'no') parts.push('无PM')
    if (g.gapMin != null && g.gapMin !== '' && g.gapMin !== 'all') parts.push(`现差≥${g.gapMin}`)
    if (g.rankDiffMin != null && g.rankDiffMin !== '' && g.rankDiffMin !== 'all') parts.push(`排差≥${g.rankDiffMin}`)
    if (g.rankDiffMax != null && g.rankDiffMax !== '' && g.rankDiffMax !== 'all') parts.push(`排差≤${g.rankDiffMax}`)
    if (g.strongRankGt != null && g.strongRankGt !== '' && g.strongRankGt !== 'all') parts.push(`强现>${g.strongRankGt}`)
    if (g.strongRankLt != null && g.strongRankLt !== '' && g.strongRankLt !== 'all') parts.push(`强现<${g.strongRankLt}`)
    if (g.requireWonFirstSet) {
      let s = '需赢首盘'
      if (g.firstSetExcludeEnabled) s += `·排除${g.firstSetExcludeScore || '7:5'}`
      parts.push(s)
    }
    return parts.length ? parts : ['未设字段（全放行）']
  }

  function normalizeSelectRows(rows) {
    if (!Array.isArray(rows)) return []
    return rows
      .map((r, i) => {
        const id = r?.id != null ? String(r.id).trim() : ''
        if (!id) return null
        const join = String(r?.joinPrev || 'or').toLowerCase()
        return { id, joinPrev: i === 0 ? 'or' : (join === 'and' ? 'and' : 'or') }
      })
      .filter(Boolean)
  }

  async function loadProductSelect() {
    if (!canEditProductSelect.value) return
    selectLoading.value = true
    selectError.value = ''
    try {
      const cfg = await api.fetchTennisEngines()
      const bucket = isPrematchMode.value ? 'prematch' : 'inplay'
      const groups = cfg?.condition?.buckets?.[bucket]?.groups || []
      libraryGroups.value = Array.isArray(groups) ? groups : []
      const product = await api.fetchAdminProduct(props.productId)
      productSnapshot.value = product
      productSelectCond.value = normalizeSelectRows(product?.conditionSelect)
      productSelectBet.value = normalizeSelectRows(product?.bettingSelect)
    } catch (e) {
      selectError.value = e?.response?.data?.error || e?.message || '加载产品条件失败'
      libraryGroups.value = []
      productSnapshot.value = null
      productSelectCond.value = []
      productSelectBet.value = []
    } finally {
      selectLoading.value = false
    }
  }

  function addSelectRow(field) {
    const list = field === 'bet' ? [...productSelectBet.value] : [...productSelectCond.value]
    const pool = isPrematchMode.value ? linkedLibraryGroups.value : libraryGroups.value
    const firstUnused = pool.find((g) => !list.some((r) => String(r.id) === String(g.id)))
    const id = firstUnused?.id || pool[0]?.id || ''
    if (!id) {
      selectError.value = `请先创建${conditionBucketLabel.value}条件组`
      return
    }
    list.push({ id: String(id), joinPrev: list.length ? 'or' : 'or' })
    if (field === 'bet') productSelectBet.value = list
    else productSelectCond.value = list
  }

  function removeSelectRow(field, index) {
    const list = field === 'bet' ? [...productSelectBet.value] : [...productSelectCond.value]
    list.splice(index, 1)
    if (list[0]) list[0] = { ...list[0], joinPrev: 'or' }
    if (field === 'bet') productSelectBet.value = list
    else productSelectCond.value = list
  }

  const productConditionGroupId = computed(() => productSelectCond.value[0]?.id || '')

  function setProductConditionGroupId(id) {
    const next = id != null && String(id).trim() ? String(id).trim() : ''
    productSelectCond.value = next ? [{ id: next, joinPrev: 'or' }] : []
  }

  function setSelectRowField(field, index, key, value) {
    const list = field === 'bet' ? [...productSelectBet.value] : [...productSelectCond.value]
    if (!list[index]) return
    list[index] = { ...list[index], [key]: value }
    if (field === 'bet') productSelectBet.value = list
    else productSelectCond.value = list
  }

  async function saveProductSelect(kind) {
    if (!canEditProductSelect.value || selectSaving.value || !productSnapshot.value) return
    selectSaving.value = true
    selectError.value = ''
    selectNotice.value = ''
    try {
      const p = productSnapshot.value
      await api.updateProduct(props.productId, {
        name: p.name,
        tag: p.tag,
        gradient: p.gradient,
        url: p.url,
        desc: p.desc,
        priceMonth: p.priceMonth,
        priceWeek: p.priceWeek,
        priceDay: p.priceDay,
        defaultPlan: p.defaultPlan,
        online: p.online,
        adminOnly: p.adminOnly,
        conditionSelect: kind === 'betting' ? normalizeSelectRows(p.conditionSelect) : productSelectCond.value,
        bettingSelect: kind === 'condition' ? normalizeSelectRows(p.bettingSelect) : productSelectBet.value,
      })
      if (kind === 'condition') {
        productSnapshot.value = { ...p, conditionSelect: [...productSelectCond.value] }
        selectNotice.value = '保存成功'
      } else {
        productSnapshot.value = { ...p, bettingSelect: [...productSelectBet.value] }
        selectNotice.value = '保存成功'
      }
      void getLoadOnce()({ quiet: true, deferSideEffects: true })
      setTimeout(() => { selectNotice.value = '' }, 2500)
    } catch (e) {
      selectError.value = `保存失败：${e?.response?.data?.error || e?.message || '请重试'}`
    } finally {
      selectSaving.value = false
    }
  }

  /** 会员列表：从 /today 返回的条件元数据还原当前生效组 */
  function hydrateConditionFromBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return
    const rules = bundle.admin_condition_rules
    const groups = Array.isArray(rules?.groups) ? rules.groups : []
    if (groups.length) {
      libraryGroups.value = groups
      conditionGroups.value = groups.map((g) => ({ ...emptyConditionGroup(), ...g, strongRankMax: 'all' }))
      conditionBucketOn.value = rules?.enabled !== false || bundle.condition_applied === true
      return
    }
    if (bundle.condition_applied === true) {
      conditionBucketOn.value = true
    }
  }

  function hydrateConditionRulesFromCache() {
    const cached = api.peekTennisEnginesCache?.({ allowStale: true })
    if (!cached?.condition?.buckets) return false
    const key = conditionBucketKey.value
    const bucket = cached.condition.buckets[key] || {}
    conditionBucketOn.value = !!bucket.enabled
    const groups = Array.isArray(bucket.groups) ? bucket.groups : []
    conditionGroups.value = groups.length
      ? groups.map((g) => ({ ...emptyConditionGroup(), ...g, strongRankMax: 'all' }))
      : [emptyConditionGroup()]
    libraryGroups.value = groups
    return true
  }

  async function loadConditionRules({ background = false } = {}) {
    if (!canEditConditionRules.value) return
    if (!background || !conditionGroups.value.length) rulesLoading.value = true
    rulesError.value = ''
    try {
      const cfg = await api.fetchTennisEngines()
      const key = conditionBucketKey.value
      const bucket = cfg?.condition?.buckets?.[key] || {}
      conditionBucketOn.value = !!bucket.enabled
      const groups = Array.isArray(bucket.groups) ? bucket.groups : []
      conditionGroups.value = groups.length
        ? groups.map((g) => ({ ...emptyConditionGroup(), ...g, strongRankMax: 'all' }))
        : [emptyConditionGroup()]
    } catch (e) {
      rulesError.value = e?.response?.data?.error || e?.message || `加载${conditionBucketLabel.value}规则失败`
    } finally {
      rulesLoading.value = false
    }
  }

  function setConditionGroupField(gi, key, raw) {
    const groups = [...conditionGroups.value]
    const g = { ...groups[gi] }
    if (['gapMin', 'rankDiffMin', 'rankDiffMax', 'strongRankGt', 'strongRankLt'].includes(key)) {
      g[key] = parseRuleNum(raw)
    } else if (key === 'joinPrev') {
      g[key] = raw === 'and' ? 'and' : 'or'
    } else if (key === 'name') {
      g[key] = String(raw || '').slice(0, 40)
    } else if (['requireWonFirstSet', 'firstSetExcludeEnabled', 'linkPrematch'].includes(key)) {
      g[key] = !!raw
    } else {
      g[key] = raw
    }
    g.strongRankMax = 'all'
    groups[gi] = g
    conditionGroups.value = groups
  }

  function addConditionGroup() {
    conditionGroups.value = [...conditionGroups.value, { ...emptyConditionGroup(), joinPrev: 'or' }]
  }

  function removeConditionGroup(gi) {
    const next = conditionGroups.value.filter((_, i) => i !== gi)
    conditionGroups.value = next.length ? next : [emptyConditionGroup()]
  }

  async function saveConditionRules() {
    if (!canEditConditionRules.value || rulesSaving.value) return
    rulesSaving.value = true
    rulesError.value = ''
    rulesNotice.value = ''
    const key = conditionBucketKey.value
    try {
      await api.updateTennisEngines({
        condition: {
          buckets: {
            [key]: {
              enabled: !!conditionBucketOn.value,
              groups: conditionGroups.value.map((g) => ({
                ...emptyConditionGroup(),
                ...g,
                strongRankMax: 'all',
              })),
            },
          },
        },
      })
      rulesNotice.value = '保存成功'
      libraryGroups.value = conditionGroups.value.map((g) => ({ ...g }))
      void getLoadOnce()({ quiet: true, deferSideEffects: true })
      setTimeout(() => { rulesNotice.value = '' }, 2500)
    } catch (e) {
      rulesError.value = `保存失败：${e?.response?.data?.error || e?.message || '请重试'}`
    } finally {
      rulesSaving.value = false
    }
  }

  async function openConditionModal() {
    if (!props.canEditRules || !isConditionBoard.value) return
    selectNotice.value = ''
    selectError.value = ''
    rulesNotice.value = ''
    rulesError.value = ''
    conditionModalOpen.value = true
    if (canEditConditionRules.value) {
      const hadCache = hydrateConditionRulesFromCache()
      void (async () => {
        await Promise.all([
          loadConditionRules({ background: hadCache }),
          loadProductSelect(),
        ])
      })()
    }
  }

  return {
    parseRuleNum,
    emptyConditionGroup,
    rulesLoading,
    rulesSaving,
    rulesError,
    rulesNotice,
    conditionBucketOn,
    conditionGroups,
    conditionModalOpen,
    selectLoading,
    selectSaving,
    selectError,
    selectNotice,
    libraryGroups,
    linkedLibraryGroups,
    productSnapshot,
    productSelectCond,
    productConditionGroupId,
    productSelectBet,
    canEditConditionRules,
    conditionBucketKey,
    conditionBucketLabel,
    canEditProductSelect,
    needsConditionGroupSelect,
    rulesSummary,
    conditionGroupLabel,
    findLibraryGroup,
    conditionGroupDetailParts,
    normalizeSelectRows,
    loadProductSelect,
    addSelectRow,
    removeSelectRow,
    setSelectRowField,
    setProductConditionGroupId,
    saveProductSelect,
    loadConditionRules,
    setConditionGroupField,
    addConditionGroup,
    removeConditionGroup,
    saveConditionRules,
    openConditionModal,
    hydrateConditionFromBundle,
  }
}
