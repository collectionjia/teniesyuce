<script setup>
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import * as api from '../api'
import { passesRangeTennis, passesTopPool, matchRangeMetrics, tierLabel, RANGE_RULES_TEXT, NEW_POOL_RULES_TEXT, matchInplayRankMetrics, inplayTierLabel } from '../utils/tennisRangeFilter'
import {
  loadFilters,
  saveFilters,
  applyPrematchFilters,
  applyInplayFilters,
  applySettledFilters,
  passesInplayBettingEntry,
  normalizeInplayBettingEntry,
  filterMatchesByConditionGroups,
} from '../utils/tennisListFilters'
import { useTennisConditionRules } from '../composables/useTennisConditionRules'
import { useTennisBettingRules } from '../composables/useTennisBettingRules'
import TennisBoardTopbar from './tennis-board/TennisBoardTopbar.vue'
import TennisBoardFilters from './tennis-board/TennisBoardFilters.vue'
import TennisBoardBatchBar from './tennis-board/TennisBoardBatchBar.vue'
import TennisBoardMatchList from './tennis-board/TennisBoardMatchList.vue'

const TennisConditionModal = defineAsyncComponent(() => import('./tennis-board/TennisConditionModal.vue'))
const TennisBettingModal = defineAsyncComponent(() => import('./tennis-board/TennisBettingModal.vue'))
const TennisBoardDetailModal = defineAsyncComponent(() => import('./tennis-board/TennisBoardDetailModal.vue'))
const TennisScheduleModal = defineAsyncComponent(() => import('./tennis-board/TennisScheduleModal.vue'))

const props = defineProps({
  showFilters: { type: Boolean, default: false },
  /** 有效订阅内可见排名/推荐/详情/外链 */
  isMember: { type: Boolean, default: false },
  /** 已配置钱包且开通 BTC 虚拟投注时可真实批量下单 */
  canBatchTrade: { type: Boolean, default: false },
  /** classic | range | live | new | inplay | prematch | settled */
  boardMode: { type: String, default: 'classic' },
  /** 仅管理员：在盘前列表直接编辑条件引擎规则 */
  canEditRules: { type: Boolean, default: false },
  /** 产品 ID：盘中挂载条件/投注选择写入该产品 */
  productId: { type: [Number, String], default: null },
})

const emit = defineEmits(['open-admin-engine', 'auto-bet-change', 'placed-orders-change'])

const isRangeMode = computed(() => props.boardMode === 'range')
const isLiveMode = computed(() => props.boardMode === 'live')
const isNewMode = computed(() => props.boardMode === 'new')
const isInplayMode = computed(() => props.boardMode === 'inplay')
const isPrematchMode = computed(() => props.boardMode === 'prematch')
const isSettledMode = computed(() => props.boardMode === 'settled')
const isClassicMode = computed(() =>
  !isRangeMode.value
  && !isLiveMode.value
  && !isNewMode.value
  && !isInplayMode.value
  && !isPrematchMode.value
  && !isSettledMode.value
)
/** 经典网球：现差/排差/强现 筛选（订阅、管理员、或已开通筛选权限） */
const classicRankFiltersOn = computed(() => isClassicMode.value && (props.isMember || props.showFilters))
/** 网球 / 网球自投：列表不展示已结束场次；盘中采集仅进行中；盘后展示已结束 */
const hideEndedEvents = computed(() => {
  if (data.value?.upstream === 'docks500' || data.value?.source === 'docks500' || data.value?.dataSource === 'docks500') {
    return false
  }
  return isClassicMode.value || isInplayMode.value || isPrematchMode.value
})
const allowBatchTrade = computed(() => {
  if (isSettledMode.value) return false
  if (props.canBatchTrade) return true
  // 会员可看到开关；真正下单须自己打开「自动投注」
  if (props.isMember && (isPrematchMode.value || isInplayMode.value)) return true
  return false
})
/** 自动投注行：各产品（非盘后）无赛事/加载中/报错时也显示 */
const showAutoBetBar = computed(() => {
  if (isSettledMode.value) return false
  if (props.canBatchTrade) return true
  if (props.isMember) return true
  return false
})
/** 仅「虚拟/采集模拟」数据源下记账；真实采集时自动下单与止损均为实盘 */
const isVirtualDataSource = computed(() => {
  if (data.value?.tradeSimulate === true) return true
  if (data.value?.tradeSimulate === false) return false
  return !!(
    data.value?.upstream === 'docks500'
    || data.value?.source === 'docks500'
    || data.value?.dataSource === 'docks500'
    || data.value?.virtualSim
  )
})
const useSimulateOrders = computed(() => !!isVirtualDataSource.value)
const apiPath = computed(() => {
  // 未订阅：与经典「网球」同源数据与展示，不走盘前/盘中专用桶与条件筛选
  if ((isPrematchMode.value || isInplayMode.value) && !props.isMember) return '/api/tennis'
  if (isPrematchMode.value) return '/api/tennis-prematch'
  if (isRangeMode.value) return '/api/tennis-range'
  if (isLiveMode.value) return '/api/tennis-live'
  if (isNewMode.value) return '/api/tennis-new'
  if (isInplayMode.value) return '/api/tennis-inplay'
  if (isSettledMode.value) return '/api/tennis-settled'
  return '/api/tennis'
})
const PAGE_SIZE = 5
const data = ref(null)
const loading = ref(true)
const error = ref('')
const filter = ref('Not started') // all | Not started | liveish | ended
const tour = ref('all') // all | ATP | WTA
const gapMin = ref('50') // all | 50 | 70 | 90 · 现排名差下限（弱−强，如 121−2=119）
const diffMax = ref('0') // all | 0 | -30 | -50 | -70 · 历史最高排名差上限
const strongRankMax = ref('20') // all | 10 | 20 | 50 | 100
const pmFilter = ref('all') // all | yes | no — 是否只看有 Polymarket 外链的场次
const topPoolMax = ref('50') // 20 | 50（新网球列表 · Top50 池内筛选）
/** 盘后：盈亏标记筛选 */
const settledPnlMark = ref('all') // all | bet | win | loss
const filtersOpen = ref(false)
const detailMatch = ref(null)
/** 详情页字段说明是否展开 */
const detailHelpOpen = ref(false)
const batchAmountUsd = ref('1')
/** 盘前/盘中手动批量：市价/限价、Up(home)/Down(away)/建议 */
const manualOrderType = ref('market')
const manualSide = ref('suggest')
const manualShares = ref('10')
const manualLimitBuyPrice = ref('0.55')
const isManualTradeBoard = computed(() => isPrematchMode.value || isInplayMode.value)
const showManualTradeOpts = computed(() => isManualTradeBoard.value && allowBatchTrade.value)

const {
  rulesLoading,
  rulesSaving,
  rulesError,
  rulesNotice,
  conditionBucketOn,
  conditionGroups,
  conditionModalOpen,
  selectLoading,
  selectError,
  selectNotice,
  libraryGroups,
  productSelectCond,
  conditionBucketLabel,
  canEditConditionRules,
  rulesSummary,
  loadProductSelect,
  loadConditionRules,
  setConditionGroupField,
  addConditionGroup,
  removeConditionGroup,
  saveConditionRules,
  openConditionModal,
  hydrateConditionFromBundle,
} = useTennisConditionRules({
  props,
  isPrematchMode,
  isInplayMode,
  getLoadOnce: () => loadOnce,
  getShowAdminEngineButtons: () => showAdminEngineButtons.value,
})

const {
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
} = useTennisBettingRules({
  props,
  isPrematchMode,
  isInplayMode,
  batchAmountUsd,
  getSyncListAutoBetFromBucket: () => syncListAutoBetFromBucket,
  getLibraryGroups: () => libraryGroups.value,
  getConditionGroups: () => conditionGroups.value,
  getLoadProductSelect: () => loadProductSelect,
  clearSelectNotices: () => {
    selectNotice.value = ''
    selectError.value = ''
  },
  getShowAdminEngineButtons: () => showAdminEngineButtons.value,
})

function openAdminEngine(kind) {
  const bucket = isInplayMode.value ? 'inplay' : 'prematch'
  try {
    sessionStorage.setItem('tennis_engine_focus', JSON.stringify({ kind, bucket }))
  } catch (_) { /* ignore */ }
  emit('open-admin-engine', { kind, bucket })
}

const DETAIL_TIPS = [
  { k: '男/女', t: '巡回赛性别（ATP 男 / WTA 女）。' },
  { k: '级别', t: '赛事级别，如 GS（大满贯）、1000、500 等。' },
  { k: '报', t: '已匹配到博彩全场胜负报价。' },
  { k: '外', t: '已匹配到 Polymarket 外链市场。' },
  { k: '盘中档', t: '按强者现排名分档（展示用）；列表条件由产品管理挂载的条件组控制。' },
  { k: '优', t: '现排名更高（数字更小）的一侧，建议关注方向。' },
  { k: '现排名 #', t: '当前世界排名，后接括号为历史最高，如 169(5)；史高优于现排时括号为绿色。' },
  { k: '比分', t: '进行中比赛的盘分/局分。' },
  { k: '年龄', t: '姓名后括号为年龄（按 2026−出生年估算）。' },
  { k: '周', t: '约一周前的排名（previous）。' },
  { k: '高', t: '历史最高排名（best），已显示在现排名括号内。' },
  { k: 'L', t: '实时排名（live ranking）。' },
  { k: 'U', t: 'UTR 评分参考。' },
  { k: '现排名差', t: '双方现排名之差（弱−强），衡量实力落差。' },
  { k: '历史最高排名差', t: '强者现排名 − 弱者历史最高排名。' },
  { k: 'Elo', t: 'Tennis Abstract 等来源的胜率/优势估计；edge 为相对报价的优势百分比。' },
  { k: '报价', t: '博彩全场胜负赔率（欧赔小数）。' },
  { k: '外链价', t: 'Polymarket 对应市场价格（美分/隐含概率）。' },
]
const selectedIds = ref(new Set())
const batchSubmitting = ref(false)
const batchNotice = ref('')
const batchError = ref('')
const AUTO_SIM_BET_KEY = computed(() => {
  if (isPrematchMode.value) return 'yuce.tennisPrematch.autoSimBet.v1'
  if (isRangeMode.value) return 'yuce.tennisRange.autoSimBet.v1'
  if (isLiveMode.value) return 'yuce.tennisLive.autoSimBet.v1'
  if (isNewMode.value) return 'yuce.tennisNew.autoSimBet.v1'
  if (isInplayMode.value) return 'yuce.tennisInplay.autoSimBet.v1'
  return 'yuce.tennis.autoSimBet.v1'
})
const AUTO_PLACED_KEY = computed(() => {
  if (isPrematchMode.value) return 'yuce.tennisPrematch.autoPlaced.v1'
  if (isRangeMode.value) return 'yuce.tennisRange.autoPlaced.v1'
  if (isLiveMode.value) return 'yuce.tennisLive.autoPlaced.v1'
  if (isNewMode.value) return 'yuce.tennisNew.autoPlaced.v1'
  if (isInplayMode.value) return 'yuce.tennisInplay.autoPlaced.v1'
  return 'yuce.tennis.autoPlaced.v1'
})
const AUTO_SOLD_KEY = computed(() => 'yuce.tennis.autoSold.v1')
/** 兼容旧盘中已卖出 key */
const AUTO_SOLD_KEY_LEGACY_INPLAY = 'yuce.tennisInplay.autoSold.v1'
/** 用户级：自动投注（默认关；真实采集=实盘，虚拟采集=记账） */
const autoSimBetEnabled = ref(false)
const autoBetEnabled = autoSimBetEnabled
const autoPlacedIds = ref(new Set())
/** 列表已下单明细（购物车）：id / label / side / amountUsd / at */
const placedOrders = ref([])
const autoSoldIds = ref(new Set())
const stopLossBusy = ref(false)
const settledStats = ref(null)
let inplayPollTimer = null
let stopLossPollTimer = null
let pageRefreshPollTimer = null
/** 页面刷新进行中：跳过重叠触发，后台异步拉数不挡交互 */
let pageRefreshInFlight = false
/** 列表自动投注 / 止损 / 页面刷新间隔（秒），来自投注引擎配置；页面刷新 0=关 */
const listAutoBetIntervalSec = ref(60)
const listStopLossIntervalSec = ref(60)
const listPageRefreshIntervalSec = ref(0)
/** 与投注引擎一致：market | limit */
const engineOrderType = ref('market')
const engineShares = ref(null)
const engineLimitBuyPrice = ref(null)
const engineLimitSellPrice = ref(null)
const scheduleModalOpen = ref(false)
const scheduleDraftAuto = ref(60)
const scheduleDraftStop = ref(60)
const scheduleDraftPage = ref(0)
const scheduleSaving = ref(false)
const scheduleError = ref('')
const scheduleNotice = ref('')

function clampPollSec(raw, fallback = 60) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(10, Math.min(600, Math.round(n)))
}

/** 0=关闭，否则 10–600 */
function clampPageRefreshSec(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.max(10, Math.min(600, Math.round(n)))
}

async function loadListPollIntervals() {
  try {
    const cfg = await api.fetchTennisEngines()
    const bet = cfg?.betting || {}
    listAutoBetIntervalSec.value = clampPollSec(bet.listAutoBetIntervalSec, 60)
    listStopLossIntervalSec.value = clampPollSec(bet.listStopLossIntervalSec, 60)
    listPageRefreshIntervalSec.value = clampPageRefreshSec(bet.listPageRefreshIntervalSec)
    engineOrderType.value = bet.orderType === 'limit' ? 'limit' : 'market'
    const sh = Math.floor(Number(bet.shares) * 100) / 100
    engineShares.value = Number.isFinite(sh) && sh > 0 ? sh : null
    const buy = Number(bet.limitBuyPrice != null ? bet.limitBuyPrice : bet.limitPrice)
    engineLimitBuyPrice.value = (buy >= 0.01 && buy <= 0.99) ? Math.round(buy * 100) / 100 : null
    const sell = Number(bet.limitSellPrice)
    engineLimitSellPrice.value = (sell >= 0.01 && sell <= 0.99) ? Math.round(sell * 100) / 100 : null
  } catch {
    listAutoBetIntervalSec.value = 60
    listStopLossIntervalSec.value = 60
    listPageRefreshIntervalSec.value = 0
    engineOrderType.value = 'market'
    engineShares.value = null
    engineLimitBuyPrice.value = null
    engineLimitSellPrice.value = null
  }
}

async function openScheduleModal() {
  if (!showAdminEngineButtons.value) return
  scheduleError.value = ''
  scheduleNotice.value = ''
  // 先用当前内存值打开，再后台刷新 engines 间隔
  scheduleDraftAuto.value = listAutoBetIntervalSec.value
  scheduleDraftStop.value = listStopLossIntervalSec.value
  scheduleDraftPage.value = listPageRefreshIntervalSec.value
  scheduleModalOpen.value = true
  void loadListPollIntervals().then(() => {
    if (!scheduleModalOpen.value) return
    scheduleDraftAuto.value = listAutoBetIntervalSec.value
    scheduleDraftStop.value = listStopLossIntervalSec.value
    scheduleDraftPage.value = listPageRefreshIntervalSec.value
  })
}

async function saveScheduleSettings() {
  if (scheduleSaving.value) return
  scheduleSaving.value = true
  scheduleError.value = ''
  scheduleNotice.value = ''
  try {
    const autoSec = clampPollSec(scheduleDraftAuto.value, 60)
    const stopSec = clampPollSec(scheduleDraftStop.value, 60)
    const pageSec = clampPageRefreshSec(scheduleDraftPage.value)
    await api.updateTennisEngines({
      betting: {
        listAutoBetIntervalSec: autoSec,
        listStopLossIntervalSec: stopSec,
        listPageRefreshIntervalSec: pageSec,
      },
    })
    listAutoBetIntervalSec.value = autoSec
    listStopLossIntervalSec.value = stopSec
    listPageRefreshIntervalSec.value = pageSec
    scheduleDraftAuto.value = autoSec
    scheduleDraftStop.value = stopSec
    scheduleDraftPage.value = pageSec
    syncInplayPoll()
    scheduleNotice.value = pageSec > 0
      ? `保存成功：页面刷新 ${pageSec}s · 自动投注 ${autoSec}s · 止损 ${stopSec}s`
      : `保存成功：页面刷新关 · 自动投注 ${autoSec}s · 止损 ${stopSec}s`
    setTimeout(() => { scheduleNotice.value = '' }, 2500)
  } catch (e) {
    scheduleError.value = `保存失败：${e?.response?.data?.error || e?.message || '请重试'}`
  } finally {
    scheduleSaving.value = false
  }
}

function openScheduleAdmin() {
  try {
    sessionStorage.setItem('tennis_engine_focus', JSON.stringify({ kind: 'scheduler' }))
  } catch (_) { /* ignore */ }
  emit('open-admin-engine', { kind: 'scheduler' })
  scheduleModalOpen.value = false
}

function pct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return `${(Number(v) * 100).toFixed(0)}%`
}
function num(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Number(v).toFixed(2)
}

function notifyAutoBetChange() {
  emit('auto-bet-change', !!autoSimBetEnabled.value)
}

function notifyPlacedOrdersChange() {
  const sold = autoSoldIds.value
  emit('placed-orders-change', sortPlacedOrdersLikeList(placedOrders.value).map((r) => ({
    ...r,
    sold: sold.has(String(r.id)),
  })))
}

/** 购物车顺序与当前列表一致（开赛时间升序）；不在列表中的排最后 */
function sortPlacedOrdersLikeList(list) {
  const order = new Map(matches.value.map((m, i) => [String(m.id), i]))
  return [...(list || [])].sort((a, b) => {
    const ia = order.has(String(a.id)) ? order.get(String(a.id)) : Number.MAX_SAFE_INTEGER
    const ib = order.has(String(b.id)) ? order.get(String(b.id)) : Number.MAX_SAFE_INTEGER
    if (ia !== ib) return ia - ib
    const ta = String(a.at || '')
    const tb = String(b.at || '')
    if (ta !== tb) return ta < tb ? -1 : 1
    return String(a.id).localeCompare(String(b.id))
  })
}

function normalizePlacedRecords(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (item && typeof item === 'object' && item.id != null) {
      out.push({
        id: String(item.id),
        label: String(item.label || item.id),
        side: item.side === 'away' ? 'away' : (item.side === 'home' ? 'home' : ''),
        sideName: item.sideName ? String(item.sideName) : '',
        homeName: item.homeName ? String(item.homeName) : '',
        awayName: item.awayName ? String(item.awayName) : '',
        amountUsd: Number.isFinite(Number(item.amountUsd)) ? Number(item.amountUsd) : null,
        at: item.at || null,
        simulated: !!item.simulated,
      })
    } else if (item != null && item !== '') {
      out.push({
        id: String(item),
        label: String(item),
        side: '',
        sideName: '',
        homeName: '',
        awayName: '',
        amountUsd: null,
        at: null,
        simulated: false,
      })
    }
  }
  return out
}

function loadTennisAutoState() {
  try {
    // 用户开启且未自行关闭时，刷新后保持勾选
    autoSimBetEnabled.value = localStorage.getItem(AUTO_SIM_BET_KEY.value) === '1'
    const raw = JSON.parse(localStorage.getItem(AUTO_PLACED_KEY.value) || '[]')
    placedOrders.value = normalizePlacedRecords(raw).slice(-200)
    autoPlacedIds.value = new Set(placedOrders.value.map((r) => r.id))
    const soldMerged = new Set()
    for (const key of [AUTO_SOLD_KEY.value, AUTO_SOLD_KEY_LEGACY_INPLAY]) {
      try {
        const sold = JSON.parse(localStorage.getItem(key) || '[]')
        if (Array.isArray(sold)) sold.forEach((id) => soldMerged.add(String(id)))
      } catch { /* ignore */ }
    }
    autoSoldIds.value = soldMerged
  } catch {
    autoSimBetEnabled.value = false
    autoPlacedIds.value = new Set()
    placedOrders.value = []
    autoSoldIds.value = new Set()
  }
  notifyAutoBetChange()
  notifyPlacedOrdersChange()
}

function saveTennisAutoState() {
  localStorage.setItem(AUTO_SIM_BET_KEY.value, autoSimBetEnabled.value ? '1' : '0')
  localStorage.setItem(AUTO_PLACED_KEY.value, JSON.stringify(placedOrders.value.slice(-200)))
  localStorage.setItem(AUTO_SOLD_KEY.value, JSON.stringify([...autoSoldIds.value].slice(-400)))
}

function rememberPlacedOrders(orders, results, amount) {
  const byId = new Map(placedOrders.value.map((r) => [r.id, r]))
  const nowIso = new Date().toISOString()
  for (const r of results || []) {
    if (!r?.ok || r.eventId == null) continue
    const id = String(r.eventId)
    const m = matches.value.find((x) => String(x.id) === id)
    const fromOrder = (orders || []).find((o) => String(o.eventId) === id)
    const side = r.side || fromOrder?.side || ''
    const home = (m ? matchHomeName(m) : '') || r.homeName || fromOrder?.homeName || ''
    const away = (m ? matchAwayName(m) : '') || r.awayName || fromOrder?.awayName || ''
    let sideName = ''
    if (side === 'away') sideName = away
    else if (side === 'home') sideName = home
    if (!sideName && r.sideName) sideName = String(r.sideName)
    if (!sideName || sideName === '—' || sideName === '?') {
      sideName = side === 'away' ? '客队' : side === 'home' ? '主队' : ''
    }
    byId.set(id, {
      id,
      label: (home || away) ? `${home || '?'} vs ${away || '?'}` : id,
      side,
      sideName,
      homeName: home || '',
      awayName: away || '',
      amountUsd: Number.isFinite(Number(r.amountUsd)) ? Number(r.amountUsd) : amount,
      at: nowIso,
      simulated: !!(r.simulated),
    })
  }
  placedOrders.value = [...byId.values()].slice(-200)
  autoPlacedIds.value = new Set(placedOrders.value.map((x) => x.id))
  saveTennisAutoState()
  notifyPlacedOrdersChange()
  syncInplayPoll()
}

async function syncListAutoBetFromBucket({ fromSave = false } = {}) {
  if (!isPrematchMode.value && !isInplayMode.value) return
  // 管理员「桶打开」只影响规则与引擎；用户是否自动投注由本人开关决定
  if (fromSave) {
    betRulesNotice.value = autoSimBetEnabled.value
      ? `保存成功；你已开启「自动投注」，将按当前列表条件在本账号下单`
      : `保存成功；有持仓时会按卖出条件与调度间隔刷 PM 并自动卖出；买入仍需自行打开「自动投注」`
  }
  await loadListPollIntervals()
  syncInplayPoll()
  if (isInplayMode.value || isPrematchMode.value) await maybeAutoStopLoss()
  if (!autoSimBetEnabled.value) return
  if (!allowBatchTrade.value) {
    const msg = '已开自动投注，但当前账号无法批量（需会员）'
    if (fromSave) betRulesError.value = msg
    else batchError.value = msg
    return
  }
  const eligible = matches.value.filter((m) => canAutoBetMatch(m))
  if (!eligible.length) {
    const msg = matches.value.length
      ? '自动投注已开，但当前列表没有满足条件且可下单的场次'
      : '自动投注已开，当前列表为空'
    if (fromSave) betRulesError.value = msg
    else batchError.value = msg
    return
  }
  await maybeAutoBatchTrade()
}

async function toggleAutoBet(ev) {
  const want = !!ev?.target?.checked
  if (want && !props.isMember && !props.canBatchTrade) {
    batchError.value = '需会员后才能开启自动投注'
    ev.target.checked = false
    return
  }
  if (want && !window.confirm(
    isInplayMode.value
      ? `确认开启「自动投注」？\n将按当前列表条件在你本账号自动下单。\n采集未开虚拟时为真实交易（需页头钱包）；虚拟采集时仅记账。\n附加：${INPLAY_AUTO_RULES_TEXT.value}`
      : '确认开启「自动投注」？\n将按当前列表条件在你本账号自动批量下单。\n采集未开虚拟时为真实交易（需页头钱包）；虚拟采集时仅记账。'
  )) {
    ev.target.checked = false
    return
  }
  autoSimBetEnabled.value = want
  saveTennisAutoState()
  notifyAutoBetChange()
  batchNotice.value = want ? '已开启自动投注' : '已关闭自动投注'
  if (want) await loadListPollIntervals()
  syncInplayPoll()
  if (want) {
    const eligible = matches.value.filter((m) => canAutoBetMatch(m))
    if (!eligible.length) {
      batchError.value = matches.value.length
        ? '自动投注已开，但当前列表没有满足条件且可下单的场次'
        : '自动投注已开，当前列表为空'
    } else {
      await maybeAutoBatchTrade()
    }
    if (isInplayMode.value || isPrematchMode.value) await maybeAutoStopLoss()
  }
}
const serverTimeBase = ref(null)
const loadedAtMs = ref(null)
const clockTick = ref(0)
let tickTimer = null

/** 基于 API 返回的服务器时间推算当前秒级时间戳 */
const nowSec = computed(() => {
  clockTick.value
  const wall = Math.floor(Date.now() / 1000)
  if (serverTimeBase.value == null || !Number.isFinite(Number(serverTimeBase.value))) return wall
  const base = Number(serverTimeBase.value)
  // 秒级时间戳；若误传毫秒则归一
  const baseSec = base > 1e12 ? Math.floor(base / 1000) : Math.floor(base)
  const derived = baseSec + Math.floor((Date.now() - (loadedAtMs.value || Date.now())) / 1000)
  // 缓存里的 serverTime 过旧时，回退本机时间，避免已开赛仍显示「未开赛」
  if (!Number.isFinite(derived) || Math.abs(derived - wall) > 120) return wall
  return derived
})

function isLiveStatus(s) {
  if (!s) return false
  const t = String(s).toLowerCase().replace(/\s+/g, '')
  return (
    t.includes('live') ||
    t === 'inprogress' ||
    t === 'started' ||
    t === 'interrupted' ||
    t.includes('1st') ||
    t.includes('2nd') ||
    t.includes('3rd') ||
    t.includes('set') ||
    t.includes('进行') ||
    t.includes('interrupt')
  )
}

function isEndedStatus(s) {
  if (!s) return false
  const t = String(s).toLowerCase()
  return t === 'ended' || t === 'finished' || t === 'closed' || t === 'walkover'
}

function statusRawText(v) {
  if (v == null) return ''
  if (typeof v === 'object') {
    return String(v.description || v.type || v.name || '').trim()
  }
  return String(v).trim()
}

function startTimestampSec(m) {
  const ts = Number(m?.startTimestamp ?? m?.start_time)
  if (!Number.isFinite(ts) || ts <= 0) return null
  return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts)
}

/** 开赛时间已到则视为进行中（与后端 serverTime 对齐）；仅对「未开赛」做超时兜底 */
function effectiveStatus(m) {
  if (!m) return ''
  const raw = statusRawText(m.status)
  const rawType = statusRawText(m.statusType || m.status?.type).toLowerCase().replace(/\s+/g, '')
  if (isEndedStatus(raw) || rawType === 'finished' || isEndedStatus(rawType)) return raw || 'Ended'
  // 源已标明进行中（含 1st/2nd set）→ 信任源数据，绝不用开赛时长强行改成结束（大满贯长盘会误伤比分）
  if (isLiveStatus(raw) || isLiveStatus(rawType)) return raw || 'Live'
  const ts = startTimestampSec(m)
  const age = ts != null ? nowSec.value - ts : null
  const notStarted =
    /^not\s*started$/i.test(raw)
    || rawType === 'notstarted'
    || raw === '未开赛'
    || (!raw && !rawType)
  if (notStarted && ts != null && nowSec.value >= ts) {
    if (age != null && age > 6 * 3600) return 'Ended'
    return 'Live'
  }
  return raw || ''
}

function isMatchEnded(m) {
  if (!m) return false
  const eff = effectiveStatus(m)
  if (isEndedStatus(eff)) return true
  const raw = m.status
  const rawType = m.statusType
  return isEndedStatus(raw) || isEndedStatus(rawType) || String(rawType || '').toLowerCase() === 'finished'
}

function isMatchLive(m) {
  if (isMatchEnded(m)) return false
  const s = effectiveStatus(m)
  return isLiveStatus(s) || isLiveStatus(m?.statusType)
}

function isMatchNotStarted(m) {
  return effectiveStatus(m) === 'Not started'
}

function rankText(v) {
  return v == null || v === '' ? '—' : String(v)
}

function shortName(name) {
  if (!name) return '—'
  const parts = String(name).trim().split(/\s+/)
  return parts.length <= 1 ? parts[0] : parts[parts.length - 1]
}

function rankDetailOf(player, match = null) {
  const id = player?.id ?? player?.teamId
  const map = data.value?.rankingsByPlayer || {}
  const fromMap = id != null ? map[String(id)] || map[id] : null
  const ev = match || detailMatch.value
  const fromEvent = id != null && ev?.rankings
    ? (ev.rankings[String(id)] || ev.rankings[id] || null)
    : null
  return {
    current: fromMap?.current ?? fromEvent?.current ?? player?.ranking ?? player?.currentRank ?? player?.rank ?? null,
    previous: fromMap?.previous ?? fromEvent?.previous ?? player?.previousRank ?? null,
    best: fromMap?.best ?? fromEvent?.best ?? player?.bestRank ?? player?.best ?? null,
    live: fromMap?.live ?? fromEvent?.live ?? player?.liveRank ?? null,
    utr: fromMap?.utr ?? fromEvent?.utr ?? player?.utr ?? null,
  }
}

function currentRankOf(player) {
  return rankDetailOf(player).current
}

function playerNameWithAge(player, eloSide) {
  const name = player?.name || '—'
  const year = 2026 // 年龄 = 2026 − 出生年
  const subs = player?.subTeams
  if (Array.isArray(subs) && subs.length) {
    const ages = subs.map((s) => {
      if (s?.birthYear != null && s.birthYear !== '') return year - Number(s.birthYear)
      if (s?.age != null && s.age !== '') return Math.floor(Number(s.age))
      return null
    })
    if (ages.every((a) => Number.isFinite(a) && a > 0)) return `${name} (${ages.join('/')})`
  }
  let age = null
  const pid = player?.id ?? player?.teamId
  const fromMap = pid != null
    ? (data.value?.birthYearByPlayer?.[String(pid)] ?? data.value?.birthYearByPlayer?.[pid])
    : null
  const birthYear = player?.birthYear ?? fromMap
  if (birthYear != null && birthYear !== '') age = year - Number(birthYear)
  else if (player?.age != null && player.age !== '') age = Math.floor(Number(player.age))
  else if (eloSide?.age != null && eloSide.age !== '') age = Math.floor(Number(eloSide.age))
  if (!Number.isFinite(age) || age <= 0) return `${name} (无)`
  return `${name} (${age})`
}

function matchMetrics(m) {
  const home = m.homePlayer || { name: m.home, ranking: null }
  const away = m.awayPlayer || { name: m.away, ranking: null }
  const homeR = currentRankOf(home)
  const awayR = currentRankOf(away)
  if (homeR == null || awayR == null) {
    return { gap: -1, rankDiff: 0, ready: false, hasRankDiff: false, strongRank: null }
  }
  // 现差 = 弱现−强现；排差 = 强者现排名 − 弱者历史最高
  const gap = Math.max(homeR, awayR) - Math.min(homeR, awayR)
  const homeStronger = homeR < awayR
  const strongNow = homeStronger ? homeR : awayR
  const homeDetail = rankDetailOf(home)
  const awayDetail = rankDetailOf(away)
  const weakBest = homeStronger
    ? (awayDetail.best != null ? Number(awayDetail.best) : null)
    : (homeDetail.best != null ? Number(homeDetail.best) : null)
  const hasRankDiff = Number.isFinite(weakBest)
  const rankDiff = hasRankDiff ? strongNow - weakBest : 0
  return { gap, rankDiff, ready: true, hasRankDiff, strongRank: strongNow }
}

function matchPassesTour(m) {
  if (tour.value === 'all') return true
  const t = (m.tour || ((m.gender || m.homePlayer?.gender || m.awayPlayer?.gender) === 'F' ? 'WTA' : 'ATP')).toUpperCase()
  return t === tour.value
}

/** 排名/现差筛选（仅用于未开始、全部；无权限时不按排名筛） */
function matchPassesRank(m) {
  if (!matchPassesTour(m)) return false
  const rankFiltersOn = isRangeMode.value || isNewMode.value
    ? props.isMember
    : classicRankFiltersOn.value
  if (!rankFiltersOn) return true
  if (isRangeMode.value) {
    return passesRangeTennis(m, data.value?.rankingsByPlayer || {})
  }
  if (isNewMode.value) {
    return passesTopPool(m, topPoolMax.value, data.value?.rankingsByPlayer || {})
  }
  const metrics = matchMetrics(m)
  if (gapMin.value !== 'all') {
    // 现排名差 ≥ 阈值（弱−强）
    if (!metrics.ready || metrics.gap < Number(gapMin.value)) return false
  }
  if (diffMax.value !== 'all') {
    if (!metrics.ready || !metrics.hasRankDiff || metrics.rankDiff > Number(diffMax.value)) return false
  }
  if (strongRankMax.value !== 'all') {
    if (!metrics.ready || metrics.strongRank == null || metrics.strongRank > Number(strongRankMax.value)) return false
  }
  return true
}

const STATUS_TABS = new Set(['all', 'Not started', 'liveish', 'ended'])

function hasPmData(m) {
  return !!polyUrlOf(m)
}

function matchPassesPm(m) {
  if (pmFilter.value === 'yes') return hasPmData(m)
  if (pmFilter.value === 'no') return !hasPmData(m)
  return true
}

function matchPassesFilter(m, statusFilter) {
  const rankings = data.value?.rankingsByPlayer || {}
  const poly = data.value?.polymarketByEvent || {}
  // 盘前/盘中/盘后：排名类条件由产品挂载的条件组在服务端筛；列表仅保留巡回/PM（盘后另保留盈亏）
  if (isPrematchMode.value) {
    // 盘前缓存里开赛时间已过的场次：状态显示「进行中」，仍留在本列表直至迁到盘中
    if (isMatchEnded(m)) return false
    return applyPrematchFilters([m], {
      tour: tour.value,
      pm: pmFilter.value,
      gapMin: 'all',
      rankDiffMax: 'all',
      strongRankMax: 'all',
    }, { rankingsByPlayer: rankings, polymarketByEvent: poly }).length > 0
  }
  if (isInplayMode.value) {
    if (!isMatchLive(m)) return false
    return applyInplayFilters([m], {
      tour: tour.value,
      pm: pmFilter.value,
      strongRankMax: 'all',
    }, { rankingsByPlayer: rankings, polymarketByEvent: poly }).length > 0
  }
  if (isSettledMode.value) {
    if (!isMatchEnded(m)) return false
    const stats = settledStats.value || {}
    return applySettledFilters([m], {
      tour: tour.value,
      pm: pmFilter.value,
      strongRankMax: 'all',
      pnlMark: settledPnlMark.value,
    }, {
      rankingsByPlayer: rankings,
      polymarketByEvent: poly,
      pnlByEvent: stats.pnlByEvent || {},
      betEventIds: stats.betEventIds || {},
    }).length > 0
  }
  if (hideEndedEvents.value && isMatchEnded(m)) return false
  const mode = STATUS_TABS.has(statusFilter) ? statusFilter : filter.value
  if (!matchPassesTour(m)) return false
  if (!matchPassesPm(m)) return false
  if (isMatchEnded(m) && mode === 'liveish') return false
  if (mode === 'liveish') {
    if (!isMatchLive(m)) return false
    return matchPassesRank(m)
  }
  if (mode === 'ended') {
    return isMatchEnded(m)
  }
  if (mode === 'Not started') {
    if (!isMatchNotStarted(m)) return false
    return matchPassesRank(m)
  }
  if (isMatchEnded(m)) return true
  return matchPassesRank(m)
}

function allMatches(bundle) {
  if (!bundle) return []
  if (isInplayMode.value) {
    return (bundle.live?.matches || []).map((e) => ({ ...e }))
  }
  const tournaments = bundle.scheduled?.tournaments || []
  const fromSched = tournaments.flatMap((t) =>
    (t.events || []).map((e) => ({
      ...e,
      tournament: e.tournament || t.name,
      tournamentShort: e.tournamentShort || t.name,
      level: e.level || t.level,
    }))
  )
  const live = (bundle.live?.matches || []).map((e) => ({ ...e }))
  const byId = new Map()
  for (const m of fromSched) {
    if (m?.id != null) byId.set(String(m.id), m)
  }
  for (const m of live) {
    if (m?.id == null) continue
    const id = String(m.id)
    const prev = byId.get(id)
    byId.set(id, prev ? { ...prev, ...m } : m)
  }
  return [...byId.values()]
}

function sortMatches(list) {
  return [...list].sort((a, b) => {
    const ta = a.startTimestamp || 0
    const tb = b.startTimestamp || 0
    if (ta !== tb) return ta - tb
    return (a.id || 0) - (b.id || 0)
  })
}

const rawMatches = computed(() => allMatches(data.value))
const matches = computed(() => sortMatches(rawMatches.value.filter((m) => matchPassesFilter(m))))
const currentPage = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(matches.value.length / PAGE_SIZE)))
const paginatedMatches = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return matches.value.slice(start, start + PAGE_SIZE)
})

watch(matches, () => {
  if (placedOrders.value.length) notifyPlacedOrdersChange()
})

watch(rawMatches, () => {
  pruneEndedPlacedOrders()
})

/** 模拟单：赛事已结束（或盘中已从列表消失）则移出购物车，避免残留 */
function pruneEndedPlacedOrders() {
  if (!placedOrders.value.length) return
  const byId = new Map(rawMatches.value.map((m) => [String(m.id), m]))
  const next = []
  let removed = 0
  for (const row of placedOrders.value) {
    const id = String(row.id)
    const m = byId.get(id)
    const isSim = !!row.simulated
    if (isSim) {
      if (m && isMatchEnded(m)) {
        removed += 1
        continue
      }
      // 盘中列表不再包含该场（通常已完赛移出）
      if (isInplayMode.value && !m) {
        removed += 1
        continue
      }
    } else if (m && isMatchEnded(m)) {
      // 实盘已结束也不再展示在购物车
      removed += 1
      continue
    }
    next.push(row)
  }
  if (!removed) return
  placedOrders.value = next
  autoPlacedIds.value = new Set(next.map((r) => String(r.id)))
  saveTennisAutoState()
  notifyPlacedOrdersChange()
}

function isInplayTier500Or1000(m) {
  const raw = String(m?.level || '').toLowerCase()
  const label = matchLevelLabel(m).toLowerCase()
  const pts = Number(m?.tennisPoints ?? m?.tournament?.tennisPoints)
  if (pts === 500 || pts === 1000) return true
  if (/\bgs\b/.test(label) || raw.includes('grand_slam') || raw.includes('grand slam')) return false
  if (/\b500\b/.test(label) || /\b1000\b/.test(label)) return true
  if (/\b500\b/.test(raw) || /\b1000\b/.test(raw) || raw.includes('masters')) return true
  return false
}

function polySidePrice(m, side) {
  const poly = polyOf(m?.id)
  if (!poly) return null
  let p = side === 'home' ? poly.home_price : poly.away_price
  const mlPrices = poly.moneyline?.prices
  if (p == null && Array.isArray(mlPrices)) {
    p = mlPrices[side === 'home' ? 0 : 1]
  }
  // 虚拟造数：prices: { home, away } 或顶层 prices
  if (p == null && mlPrices && typeof mlPrices === 'object' && !Array.isArray(mlPrices)) {
    p = side === 'home' ? mlPrices.home : mlPrices.away
  }
  if (p == null && poly.prices && typeof poly.prices === 'object') {
    p = side === 'home' ? poly.prices.home : poly.prices.away
  }
  if (p == null) return null
  const n = Number(p)
  if (!Number.isFinite(n)) return null
  return n <= 1 ? n : n / 100
}

function strongPolyPriceCents(m) {
  const side = pickSide(m)
  if (!side) return null
  const p = polySidePrice(m, side)
  if (p == null) return null
  return p * 100
}

function strongWonSet(m, setIndex = 1) {
  const side = pickSide(m)
  if (!side) return false
  const pairs = liveSetPairs(m)
  const idx = Number(setIndex)
  const i = Number.isFinite(idx) ? Math.max(1, Math.min(5, Math.round(idx))) : 1
  const set = pairs[i - 1]
  if (!set) return false
  if (!isTennisSetComplete(set.home, set.away)) return false
  if (set.home === set.away) return false
  return side === 'home' ? set.home > set.away : set.away > set.home
}

function strongWonFirstSet(m) {
  return strongWonSet(m, 1)
}

function isTennisSetComplete(a, b) {
  const x = Number(a)
  const y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  const hi = Math.max(x, y)
  const lo = Math.min(x, y)
  if (hi >= 7) return true
  if (hi >= 6 && hi - lo >= 2) return true
  return false
}

/** ATP 大满贯男单等 BO5；已打到第 4/5 盘也视为 BO5 */
function isBo5Match(m) {
  const pairs = liveSetPairs(m)
  if (pairs.length >= 4) return true
  const label = matchLevelLabel(m).toLowerCase()
  const raw = String(m?.level || '').toLowerCase()
  const isGs = /\bgs\b/.test(label) || raw.includes('grand_slam') || raw.includes('grand slam')
  if (!isGs) return false
  const tour = String(m.tour || '').toUpperCase()
  const gender = String(m.gender || m.homePlayer?.gender || m.awayPlayer?.gender || '').toUpperCase()
  if (tour === 'WTA' || gender === 'F' || gender === 'W') return false
  return true
}

function analyzeStrongSets(m, strongSide) {
  const pairs = liveSetPairs(m)
  let strongSets = 0
  let weakSets = 0
  let current = null
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]
    const s = strongSide === 'home' ? p.home : p.away
    const w = strongSide === 'home' ? p.away : p.home
    if (isTennisSetComplete(s, w)) {
      if (s > w) strongSets += 1
      else weakSets += 1
    } else {
      current = { strong: s, weak: w, setIndex: i + 1 }
    }
  }
  return { strongSets, weakSets, current, pairs }
}

function gamesTrailStopLoss(strongG, weakG, lead = 2) {
  const need = Number(lead)
  const n = Number.isFinite(need) ? need : 2
  // 与文案「局差≥」一致（弱方领先局数）
  return strongG < weakG && weakG - strongG >= n
}

function matchConfiguredStopRule(m, side, rule) {
  const { strongSets, weakSets, current } = analyzeStrongSets(m, side)
  const pmMaxRaw = rule.stopPmCentsMax
  const pmMax = Number(pmMaxRaw)
  // 未设置 PM¢（空 / all / 无效）→ 不参与判断；场次无赔率时同样跳过
  const wantPm = pmMaxRaw != null && pmMaxRaw !== '' && pmMaxRaw !== 'all' && Number.isFinite(pmMax) && pmMax > 0
  let applyPm = false
  let pmOk = true
  if (wantPm) {
    const p = polySidePrice(m, side)
    if (p != null) {
      applyPm = true
      pmOk = (p * 100) < pmMax
    }
  }

  const fmt = String(rule.stopFormat || 'any').toLowerCase()
  const hasFormat = fmt === 'bo3' || fmt === 'bo5'
  const setIndex = Number(rule.stopSetIndex)
  const hasSetIndex = Number.isFinite(setIndex) && setIndex > 0 && rule.stopSetIndex !== '' && rule.stopSetIndex !== 'all'
  const hasStrongSets = rule.stopStrongSets != null && rule.stopStrongSets !== '' && rule.stopStrongSets !== 'all'
  const hasWeakSets = rule.stopWeakSets != null && rule.stopWeakSets !== '' && rule.stopWeakSets !== 'all'
  const lead = rule.stopGameLead
  const hasTrail = !(lead == null || lead === '' || lead === 'all')
  // 局差与 PM 作为整体 OR；弱方局分已弃用
  const hasAnyConstraint = applyPm || hasFormat || hasSetIndex || hasStrongSets || hasWeakSets || hasTrail
  if (!hasAnyConstraint) return false

  // 无比分：仅当确有 PM 赔率可算时，才允许纯 PM 触发
  if (!current) {
    return applyPm && pmOk
  }

  const bo5 = isBo5Match(m)
  if (fmt === 'bo3' && bo5) return false
  if (fmt === 'bo5' && !bo5) return false
  if (hasSetIndex && current.setIndex !== setIndex) return false
  if (hasStrongSets) {
    if (strongSets !== Number(rule.stopStrongSets)) return false
  }
  if (hasWeakSets) {
    if (weakSets !== Number(rule.stopWeakSets)) return false
  }
  if (hasTrail || applyPm) {
    const trailOk = hasTrail ? gamesTrailStopLoss(current.strong, current.weak, lead) : false
    const pOk = applyPm ? pmOk : false
    if (hasTrail && applyPm) {
      if (!(trailOk || pOk)) return false
    } else if (hasTrail) {
      if (!trailOk) return false
    } else if (!pOk) {
      return false
    }
  }
  return true
}

function matchConfiguredStopGroup(m, side, group) {
  if (group.stopEnabled === false) return false
  const rules = Array.isArray(group.stopRules) ? group.stopRules : []
  if (!rules.length) return false
  let acc = null
  for (let i = 0; i < rules.length; i++) {
    const rule = softenStopRuleForMatch(rules[i])
    const hit = matchConfiguredStopRule(m, side, rule)
    if (i === 0) acc = hit
    else if (String(rules[i].joinPrev || 'or').toLowerCase() === 'and') acc = acc && hit
    else acc = acc || hit
  }
  return !!acc
}

/** 旧默认 BO3+第3盘+局差2 在匹配时视为未填，避免只改了 PM 永远不卖 */
function softenStopRuleForMatch(r) {
  const o = { ...(r || {}) }
  const fmt = String(o.stopFormat || '').toLowerCase()
  if (fmt === 'bo3' && Number(o.stopSetIndex) === 3 && Number(o.stopGameLead) === 2) {
    o.stopFormat = 'any'
    o.stopSetIndex = 'all'
    o.stopGameLead = 'all'
  }
  return o
}

/** 持仓买入侧：优先购物车记录，否则回退建议侧 */
function heldSideOf(eventId, m) {
  const id = String(eventId || m?.id || '')
  const row = placedOrders.value.find((r) => String(r.id) === id)
  if (row?.side === 'home' || row?.side === 'away') return row.side
  if (row?.sideName && m) {
    const sn = String(row.sideName || '').trim().toLowerCase()
    const home = String(matchHomeName(m) || '').trim().toLowerCase()
    const away = String(matchAwayName(m) || '').trim().toLowerCase()
    if (sn && home && sn === home) return 'home'
    if (sn && away && sn === away) return 'away'
  }
  return pickSide(m)
}

function openPlacedIds() {
  return [...autoPlacedIds.value].filter((id) => !autoSoldIds.value.has(String(id))).map(String)
}

function hasConfiguredStopLoss() {
  return bettingGroups.value.some((g) => g.stopEnabled !== false && ensureStopRules(g).length > 0)
}

/** 有未平仓持仓，且已配止损（或盘中可走默认止损）时，按调度刷 PM 并自动卖 */
function shouldRunStopLossMonitor() {
  if (!isPrematchMode.value && !isInplayMode.value) return false
  if (!allowBatchTrade.value) return false
  if (!openPlacedIds().length) return false
  if (hasConfiguredStopLoss()) return true
  return isInplayMode.value
}

/** 盘前/盘中止损：有配置止损组则按配置；盘中无配置时回退默认规则。sideOverride=持仓侧 */
function shouldConfiguredOrDefaultStopLoss(m, sideOverride = null) {
  if (isMatchEnded(m)) return false
  const side = sideOverride || pickSide(m)
  if (!side) return false

  const configured = bettingGroups.value.filter((g) => g.stopEnabled !== false && ensureStopRules(g).length)
  if (configured.length) {
    // 有 PM 止损时可在未开打时判断；纯比分止损仍需已开打
    const anyPmStop = configured.some((g) => ensureStopRules(g).some((r) => {
      const v = r?.stopPmCentsMax
      return v != null && v !== '' && v !== 'all' && Number(v) > 0
    }))
    if (!anyPmStop && !isMatchLive(m) && !liveSetPairs(m).length) return false
    let acc = null
    for (let i = 0; i < configured.length; i++) {
      const hit = matchConfiguredStopGroup(m, side, configured[i])
      if (i === 0) acc = hit
      else if (String(configured[i].joinPrev || 'or').toLowerCase() === 'and') acc = acc && hit
      else acc = acc || hit
    }
    return !!acc
  }

  if (!isInplayMode.value || !isMatchLive(m)) return false
  const { strongSets, weakSets, current } = analyzeStrongSets(m, side)
  if (!current || !gamesTrailStopLoss(current.strong, current.weak, 2)) return false
  if (isBo5Match(m)) {
    if (strongSets === 1 && weakSets === 2 && current.setIndex === 4) return true
    if (strongSets === 2 && weakSets === 2 && current.setIndex === 5) return true
    return false
  }
  return strongSets === 1 && weakSets === 1 && current.setIndex === 3
}

function shouldInplayStopLoss(m) {
  return shouldConfiguredOrDefaultStopLoss(m, heldSideOf(m?.id, m))
}

function resolveBatchStakeUsd() {
  const fromInput = Number(batchAmountUsd.value)
  return fromInput >= 1 ? fromInput : 1
}

function resolveAutoBetConditionGroups() {
  const fromBundle = data.value?.admin_condition_rules?.groups
  if (Array.isArray(fromBundle) && fromBundle.length) return fromBundle
  // 盘前：勾选「关联未开赛」的组直接生效
  if (isPrematchMode.value) {
    const pool = libraryGroups.value?.length ? libraryGroups.value : (conditionGroups.value || [])
    const linked = pool.filter((g) => g?.linkPrematch === true)
    return linked.map((g, i) => ({
      ...g,
      joinPrev: i === 0 ? 'or' : (String(g?.joinPrev || 'or').toLowerCase() === 'and' ? 'and' : 'or'),
    }))
  }
  if (props.productId != null && productSelectCond.value?.length && libraryGroups.value?.length) {
    const byId = new Map(libraryGroups.value.filter((g) => g?.id).map((g) => [String(g.id), g]))
    const out = []
    productSelectCond.value.forEach((row, i) => {
      const def = byId.get(String(row?.id))
      if (!def) return
      const join = String(row?.joinPrev || 'or').toLowerCase() === 'and' ? 'and' : 'or'
      out.push({ ...def, joinPrev: i === 0 ? 'or' : join })
    })
    if (out.length) return out
  }
  if (conditionBucketOn.value && conditionGroups.value?.length) {
    return conditionGroups.value
  }
  return []
}

function passesListConditionGroups(m) {
  const groups = resolveAutoBetConditionGroups()
  if (!groups.length) return true
  const ctx = {
    rankingsByPlayer: data.value?.rankingsByPlayer || {},
    polymarketByEvent: data.value?.polymarketByEvent || {},
  }
  return filterMatchesByConditionGroups([m], groups, ctx).length > 0
}

/** 自动投注：仅当前列表内、满足条件组、未买过/未卖过的场次 */
function canAutoBetMatch(m) {
  if (!props.isMember || !allowBatchTrade.value) return false
  if (!m?.id || isMatchEnded(m)) return false
  const id = String(m.id)
  if (autoPlacedIds.value.has(id) || autoSoldIds.value.has(id)) return false
  if (!polyUrlOf(m)) return false
  if (!pickSide(m)) return false
  if (!matches.value.some((x) => String(x.id) === id)) return false
  if (!passesListConditionGroups(m)) return false
  if (isInplayMode.value && !data.value?.condition_applied) {
    return passesInplayAutoBet(m)
  }
  return true
}

function passesInplayAutoBet(m) {
  if (!isInplayMode.value || !isMatchLive(m) || isMatchEnded(m)) return false
  const side = pickSide(m)
  if (!side) return false
  if (!polyUrlOf(m)) return false
  return passesInplayBettingEntry(m, data.value?.rankingsByPlayer || {}, bettingEntry.value, {
    strongWonSet,
    strongWonFirstSet,
    strongPolyCents: strongPolyPriceCents,
    getSetGames: (match, setIndex = 1) => {
      const pairs = liveSetPairs(match)
      const idx = Number(setIndex)
      const i = Number.isFinite(idx) ? Math.max(1, Math.min(5, Math.round(idx))) : 1
      const set = pairs[i - 1]
      if (!set) return null
      return { home: set.home, away: set.away }
    },
    getFirstSetGames: (match) => {
      const pairs = liveSetPairs(match)
      if (!pairs.length) return null
      const first = pairs[0]
      return { home: first.home, away: first.away }
    },
  })
}

function canSelectMatch(m) {
  if (isSettledMode.value) return false
  if (!props.isMember || !allowBatchTrade.value) return false
  if (!m?.id || isMatchEnded(m)) return false
  const id = String(m.id)
  if (autoPlacedIds.value.has(id) || autoSoldIds.value.has(id)) return false
  if (!polyUrlOf(m)) return false
  // 盘中手动：进行中即可勾选（不强制过自动进场条件）
  if (isInplayMode.value && !isMatchLive(m)) return false
  // 手动选 Up/Down 时可不等建议侧
  if (
    isManualTradeBoard.value
    && (manualSide.value === 'home' || manualSide.value === 'away')
  ) {
    return true
  }
  return pickSide(m) != null
}

function isSelected(m) {
  return selectedIds.value.has(String(m.id))
}

function toggleSelect(m) {
  if (!canSelectMatch(m)) return
  const id = String(m.id)
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function clearSelection() {
  selectedIds.value = new Set()
}

const selectedCount = computed(() => selectedIds.value.size)

const pageSelectable = computed(() => paginatedMatches.value.filter(canSelectMatch))

const pageAllSelected = computed(() => {
  const list = pageSelectable.value
  if (!list.length) return false
  return list.every((m) => selectedIds.value.has(String(m.id)))
})

function toggleSelectPage() {
  const list = pageSelectable.value
  if (!list.length) return
  const next = new Set(selectedIds.value)
  if (pageAllSelected.value) {
    for (const m of list) next.delete(String(m.id))
  } else {
    for (const m of list) next.add(String(m.id))
  }
  selectedIds.value = next
}

function resolveManualSide(m) {
  if (manualSide.value === 'home' || manualSide.value === 'away') return manualSide.value
  return pickSide(m)
}

function buildBatchOrders({ manual = false } = {}) {
  return [...selectedIds.value].map((eventId) => {
    const id = String(eventId)
    if (autoPlacedIds.value.has(id) || autoSoldIds.value.has(id)) return null
    const m = matches.value.find((x) => String(x.id) === eventId)
    const side = manual && isManualTradeBoard.value ? resolveManualSide(m) : pickSide(m)
    if (!m || !side) return null
    return {
      eventId,
      side,
      homeName: matchHomeName(m),
      awayName: matchAwayName(m),
    }
  }).filter(Boolean)
}

function formatBatchResultLine(r, list) {
  const m = list.find((x) => String(x.id) === String(r.eventId))
  const label = m
    ? `${matchHomeName(m)} vs ${matchAwayName(m)}`
    : String(r.eventId)
  if (r.ok) {
    const fill = r.takingAmount || r.makingAmount
    return `${label}：已确认${fill ? ` (${fill})` : ''}`
  }
  return `${label}：${r.error || '失败'}`
}

const BATCH_TRADE_CHUNK = 20

async function placeBatchTradeRequest(orders, amount, { manual = false } = {}) {
  const useManual = manual && isManualTradeBoard.value
  const orderType = useManual
    ? (manualOrderType.value === 'limit' ? 'limit' : 'market')
    : engineOrderType.value
  const payload = {
    orders,
    amountUsd: amount,
    simulate: !!useSimulateOrders.value,
    orderType,
  }
  if (orderType === 'limit') {
    if (useManual) {
      const sh = Math.floor(Number(manualShares.value) * 100) / 100
      const lp = Number(manualLimitBuyPrice.value)
      if (sh > 0) payload.shares = sh
      if (lp >= 0.01 && lp <= 0.99) {
        payload.limitBuyPrice = Math.round(lp * 100) / 100
        payload.limitPrice = payload.limitBuyPrice
      }
    } else {
      if (engineShares.value != null) payload.shares = engineShares.value
      if (engineLimitBuyPrice.value != null) {
        payload.limitBuyPrice = engineLimitBuyPrice.value
        payload.limitPrice = engineLimitBuyPrice.value
      }
    }
  }
  // 手动选 Up/Down 时放行非建议侧
  if (useManual && (manualSide.value === 'home' || manualSide.value === 'away')) {
    payload.allowAnySide = true
  }
  if (isPrematchMode.value) return api.placeTennisPrematchBatchTrade(payload)
  if (isRangeMode.value) return api.placeTennisRangeBatchTrade(payload)
  if (isLiveMode.value) return api.placeTennisLiveBatchTrade(payload)
  if (isInplayMode.value) return api.placeTennisInplayBatchTrade(payload)
  if (isNewMode.value) return api.placeTennisNewBatchTrade(payload)
  return api.placeTennisBatchTrade(payload)
}

async function submitBatchTrade({ auto = false } = {}) {
  batchError.value = ''
  if (!auto) batchNotice.value = ''
  if (auto && !autoSimBetEnabled.value) return
  if (!auto && !props.canBatchTrade && !autoSimBetEnabled.value) {
    batchError.value = '默认不下单。请先开启「自动投注」，或配置钱包后手动实盘批量'
    return
  }
  const manual = !auto && isManualTradeBoard.value
  const orders = buildBatchOrders({ manual })
  if (!orders.length) {
    if (!auto) batchError.value = '请先勾选可同步的场次'
    return
  }
  let amount = resolveBatchStakeUsd()
  const orderType = manual
    ? (manualOrderType.value === 'limit' ? 'limit' : 'market')
    : engineOrderType.value
  if (orderType === 'limit') {
    const sh = manual ? Number(manualShares.value) : Number(engineShares.value)
    const lp = manual ? Number(manualLimitBuyPrice.value) : Number(engineLimitBuyPrice.value)
    if (!(sh > 0)) {
      batchError.value = manual ? '限价单请填写份额' : '限价单请先在投注引擎填写份额'
      return
    }
    if (!(lp >= 0.01 && lp <= 0.99)) {
      batchError.value = manual
        ? '限价单请填写买入目标价（0.01–0.99）'
        : '限价单请先在投注引擎填写买入目标价（0.01–0.99）'
      return
    }
    amount = Math.round(sh * lp * 100) / 100
  } else if (!(amount >= 1)) {
    batchError.value = '每场金额至少 1 元'
    return
  }
  batchSubmitting.value = true
  try {
    // 服务端单次最多 20 场；盘前自动勾选常超限，需分批否则整单被拒、一单不下
    const chunks = []
    for (let i = 0; i < orders.length; i += BATCH_TRADE_CHUNK) {
      chunks.push(orders.slice(i, i + BATCH_TRADE_CHUNK))
    }
    const allResults = []
    let success = 0
    let failed = 0
    for (const chunk of chunks) {
      const resp = await placeBatchTradeRequest(chunk, amount, { manual })
      const part = Array.isArray(resp?.results) ? resp.results : []
      allResults.push(...part)
      success += Number(resp?.success) || part.filter((r) => r?.ok).length
      failed += Number(resp?.failed) || part.filter((r) => !r?.ok).length
    }
    const lines = allResults.map((r) => formatBatchResultLine(r, matches.value))
    if (success > 0) {
      const okLines = lines.filter((_, i) => allResults[i]?.ok)
      if (auto) {
        batchNotice.value = [
          `自动投注成功 ${success} 场`,
          chunks.length > 1 ? `分 ${chunks.length} 批提交` : null,
          ...okLines.slice(0, 3),
          okLines.length > 3 ? `…另有 ${okLines.length - 3} 场成功` : null,
        ].filter(Boolean).join('\n')
      } else {
        batchNotice.value = [
          chunks.length > 1 ? `已分 ${chunks.length} 批提交，成功 ${success} 场` : null,
          ...okLines,
        ].filter(Boolean).join('\n')
      }
      const failedIds = new Set(allResults.filter((r) => !r.ok).map((r) => String(r.eventId)))
      const next = new Set(selectedIds.value)
      for (const o of orders) {
        const id = String(o.eventId)
        if (!failedIds.has(id)) next.delete(id)
      }
      selectedIds.value = next
      rememberPlacedOrders(orders, allResults, amount)
    } else if (!auto) {
      batchNotice.value = ''
    }
    if (failed > 0 || success === 0) {
      batchError.value = lines.filter((_, i) => !allResults[i]?.ok).join('\n')
        || '批量同步失败'
    }
  } catch (e) {
    batchError.value = e.response?.data?.error || e.message || '批量同步失败'
  } finally {
    batchSubmitting.value = false
  }
}

async function maybeAutoBatchTrade() {
  if (!autoBetEnabled.value || !allowBatchTrade.value || batchSubmitting.value) return
  const candidates = matches.value.filter((m) => canAutoBetMatch(m))
  if (!candidates.length) {
    if ((isInplayMode.value || isPrematchMode.value) && !batchNotice.value) {
      batchNotice.value = '自动投注已开，当前列表暂无满足条件的新场次'
    }
    return
  }
  const next = new Set(selectedIds.value)
  for (const m of candidates) next.add(String(m.id))
  selectedIds.value = next
  await submitBatchTrade({ auto: true })
}

async function placeStopSell(m, side, { simulate } = {}) {
  const payload = {
    eventId: String(m.id),
    side,
    shares: 'all',
    simulate: simulate != null ? !!simulate : !!useSimulateOrders.value,
    orderType: engineOrderType.value,
  }
  if (engineOrderType.value === 'limit' && engineLimitSellPrice.value != null) {
    payload.limitSellPrice = engineLimitSellPrice.value
  }
  if (isPrematchMode.value) return api.placeTennisPrematchSell(payload)
  return api.placeTennisInplaySell(payload)
}

/** 购物车手动卖出：平仓后写入已卖出，后续不再自动买入该场 */
async function sellPlacedOrder(eventId) {
  const id = String(eventId || '')
  if (!id) throw new Error('缺少赛事')
  if (autoSoldIds.value.has(id)) return { ok: true, alreadySold: true }
  if (batchSubmitting.value || stopLossBusy.value) throw new Error('请稍候再试')
  const row = placedOrders.value.find((r) => String(r.id) === id)
  const m = rawMatches.value.find((x) => String(x.id) === id)
    || matches.value.find((x) => String(x.id) === id)
  let side = row?.side === 'away' || row?.side === 'home' ? row.side : ''
  if (!side && m) side = pickSide(m) || ''
  // 仅有 sideName 时反推方向
  if (!side && row && m) {
    const sn = String(row.sideName || '').trim().toLowerCase()
    const home = String(matchHomeName(m) || '').trim().toLowerCase()
    const away = String(matchAwayName(m) || '').trim().toLowerCase()
    if (sn && home && sn === home) side = 'home'
    else if (sn && away && sn === away) side = 'away'
  }
  if (!side && row?.sideName) {
    // 购物车仍有记录但列表已无该场：默认按买入侧字符串兜底
    side = 'home'
  }
  if (!side) throw new Error('无法确定买入方向，不能卖出')

  // 真实采集下，旧模拟单只本地平仓；否则按采集源决定是否模拟
  const simulate = !!useSimulateOrders.value
  if (!simulate && row?.simulated) {
    const sold = new Set(autoSoldIds.value)
    sold.add(id)
    autoSoldIds.value = sold
    saveTennisAutoState()
    notifyPlacedOrdersChange()
    syncInplayPoll()
    batchNotice.value = `已本地平仓（原模拟单）：${row?.label || id}（不再自动下单）`
    return { ok: true, simulated: true, localOnly: true }
  }

  stopLossBusy.value = true
  try {
    let resp = { ok: true, simulated: simulate }
    if (isPrematchMode.value || isInplayMode.value) {
      try {
        resp = await placeStopSell(m || { id }, side, { simulate })
      } catch (e) {
        // 模拟单：接口失败也本地记为已卖出，保证购物车可用
        if (simulate) {
          resp = {
            ok: true,
            simulated: true,
            localOnly: true,
            error: e?.response?.data?.error || e?.message || '',
          }
        } else {
          throw e
        }
      }
    }
    const sold = new Set(autoSoldIds.value)
    sold.add(id)
    autoSoldIds.value = sold
    saveTennisAutoState()
    notifyPlacedOrdersChange()
    syncInplayPoll()
    batchNotice.value = `已卖出${simulate ? '（模拟）' : ''}：${row?.label || id}（不再自动下单）`
    return { ok: true, ...resp }
  } finally {
    stopLossBusy.value = false
  }
}

/** 清理卖出记录：从购物车移除已卖出，并解除其「禁止再买」标记 */
function clearSoldPlacedOrders() {
  const soldIds = new Set([...autoSoldIds.value].map(String))
  const before = soldIds.size
  if (!before && !placedOrders.value.some((r) => soldIds.has(String(r.id)))) {
    return { cleared: 0 }
  }
  placedOrders.value = placedOrders.value.filter((r) => !soldIds.has(String(r.id)))
  autoPlacedIds.value = new Set(placedOrders.value.map((r) => String(r.id)))
  autoSoldIds.value = new Set()
  try {
    localStorage.removeItem(AUTO_SOLD_KEY_LEGACY_INPLAY)
  } catch { /* ignore */ }
  saveTennisAutoState()
  notifyPlacedOrdersChange()
  syncInplayPoll()
  return { cleared: before }
}

async function maybeAutoStopLoss() {
  if ((!isInplayMode.value && !isPrematchMode.value) || !allowBatchTrade.value) return
  if (batchSubmitting.value || stopLossBusy.value) return
  if (!shouldRunStopLossMonitor()) return
  const byId = new Map(rawMatches.value.map((m) => [String(m.id), m]))
  const targets = []
  const localClose = []
  for (const id of openPlacedIds()) {
    const m = byId.get(id)
    if (!m) continue
    const side = heldSideOf(id, m)
    if (!side) continue
    if (!shouldConfiguredOrDefaultStopLoss(m, side)) continue
    const row = placedOrders.value.find((r) => String(r.id) === id)
    // 真实采集：旧模拟单无链上仓位，仅本地平仓；实盘单走真实止损
    if (!isVirtualDataSource.value && row?.simulated) {
      localClose.push({ m, row })
      continue
    }
    targets.push({ m, side, simulate: !!isVirtualDataSource.value })
  }
  if (!targets.length && !localClose.length) return
  stopLossBusy.value = true
  const sold = new Set(autoSoldIds.value)
  const lines = []
  try {
    for (const { m, row } of localClose) {
      const id = String(m.id)
      sold.add(id)
      const label = row?.label || `${matchHomeName(m)} vs ${matchAwayName(m)}`
      lines.push(`${label}：原模拟单已本地平仓`)
    }
    for (const { m, side, simulate } of targets) {
      const id = String(m.id)
      try {
        let resp
        try {
          resp = await placeStopSell(m, side, { simulate })
        } catch (e) {
          // 虚拟记账：接口失败也本地落袋；实盘失败则抛出
          if (simulate) {
            resp = { ok: true, simulated: true, localOnly: true, error: e?.response?.data?.error || e?.message }
          } else {
            throw e
          }
        }
        sold.add(id)
        const label = `${matchHomeName(m)} vs ${matchAwayName(m)}`
        const tag = resp?.localOnly ? '（本页记账）' : (simulate || resp?.simulated ? '（模拟）' : '')
        lines.push(`${label}：止损已平仓${resp?.soldShares ? ` (${resp.soldShares})` : ''}${tag}`)
      } catch (e) {
        const label = `${matchHomeName(m)} vs ${matchAwayName(m)}`
        lines.push(`${label}：止损失败 ${e.response?.data?.error || e.message || ''}`)
        batchError.value = lines.join('\n')
      }
    }
    if (sold.size !== autoSoldIds.value.size) {
      autoSoldIds.value = sold
      saveTennisAutoState()
      notifyPlacedOrdersChange()
      syncInplayPoll()
    }
    if (lines.some((l) => l.includes('已平仓'))) {
      batchNotice.value = ['自动止损（已卖出赛事不再买入）', ...lines.filter((l) => l.includes('已平仓')).slice(0, 5)].join('\n')
    }
  } finally {
    stopLossBusy.value = false
  }
}

function clearListPollTimers() {
  if (inplayPollTimer) {
    clearInterval(inplayPollTimer)
    inplayPollTimer = null
  }
  if (stopLossPollTimer) {
    clearInterval(stopLossPollTimer)
    stopLossPollTimer = null
  }
  if (pageRefreshPollTimer) {
    clearInterval(pageRefreshPollTimer)
    pageRefreshPollTimer = null
  }
}

function syncInplayPoll() {
  clearListPollTimers()
  if (!isInplayMode.value && !isPrematchMode.value) return
  const needBuy = !!autoBetEnabled.value
  const needStop = shouldRunStopLossMonitor()
  const pageSec = clampPageRefreshSec(listPageRefreshIntervalSec.value)
  const needPage = pageSec > 0
  if (!needBuy && !needStop && !needPage) return
  const buyMs = clampPollSec(listAutoBetIntervalSec.value, 60) * 1000
  const stopMs = clampPollSec(listStopLossIntervalSec.value, 60) * 1000
  const pageMs = pageSec * 1000

  if (needPage) {
    pageRefreshPollTimer = setInterval(() => {
      if (pageRefreshInFlight) return
      pageRefreshInFlight = true
      void loadOnce({ quiet: true, deferSideEffects: true })
        .catch(() => { /* 异步刷新失败不打断页面 */ })
        .finally(() => { pageRefreshInFlight = false })
    }, pageMs)
  }
  // 自动投注：若与页面刷新同间隔则已由页面刷新覆盖
  if (needBuy && (!needPage || pageMs !== buyMs)) {
    inplayPollTimer = setInterval(() => {
      void loadOnce({ quiet: true, deferSideEffects: true })
        .catch(() => {})
    }, buyMs)
  }
  // 止损：跳过已由页面刷新或买入同间隔覆盖的情况
  if (needStop) {
    const coveredByBuy = needBuy && stopMs === buyMs && (!needPage || pageMs !== buyMs)
    const coveredByPage = needPage && pageMs === stopMs
    if (!coveredByBuy && !coveredByPage) {
      stopLossPollTimer = setInterval(() => {
        void loadOnce({ quiet: true, skipAutoBatch: true, deferSideEffects: true })
          .catch(() => {})
      }, stopMs)
    }
  }
}

watch([filter, tour, gapMin, diffMax, strongRankMax, topPoolMax, pmFilter, settledPnlMark], () => {
  currentPage.value = 1
  clearSelection()
  if (autoBetEnabled.value && (isPrematchMode.value || isInplayMode.value)) {
    void maybeAutoBatchTrade()
  }
})

watch(
  () => (autoBetEnabled.value ? matches.value.map((m) => String(m.id)).join('|') : ''),
  () => {
    if (autoBetEnabled.value && (isPrematchMode.value || isInplayMode.value)) {
      void maybeAutoBatchTrade()
    }
  },
)

watch(() => props.isMember, (ok) => {
  if (!ok) {
    closeDetail()
    clearSelection()
  }
  if (isPrematchMode.value || isInplayMode.value) {
    void loadOnce({ quiet: true })
  }
})

watch(totalPages, (pages) => {
  if (currentPage.value > pages) currentPage.value = pages
})

function goPage(page) {
  const p = Math.min(Math.max(1, page), totalPages.value)
  currentPage.value = p
}

function setStatusFilter(mode) {
  if (isPrematchMode.value) return
  if (hideEndedEvents.value && mode === 'ended') return
  if (filter.value === mode) return
  filter.value = mode
  currentPage.value = 1
}

const stats = computed(() => {
  const pool = rawMatches.value.filter((m) => matchPassesTour(m) && matchPassesPm(m))
  const countTab = (tab) => {
    // 盘前桶仅未开赛；进行中/已结束分属盘中/盘后，勿与未开重复计数
    if (isPrematchMode.value) {
      if (tab === 'liveish' || tab === 'ended') return 0
      return pool.filter((m) => matchPassesFilter(m, 'Not started')).length
    }
    return pool.filter((m) => matchPassesFilter(m, tab)).length
  }
  const collected = isPrematchMode.value
    ? countTab('Not started')
    : isInplayMode.value
    ? (data.value?.live?.eventCount ?? data.value?.events ?? pool.length)
    : classicRankFiltersOn.value
      ? countTab(filter.value)
      : (data.value?.events ?? data.value?.scheduled?.eventCount ?? 0)
  return {
    date: data.value?.date || '—',
    tournaments: isInplayMode.value
      ? (data.value?.live?.tournamentCount ?? 0)
      : (data.value?.scheduled?.tournamentCount ?? 0),
    collected,
    total: pool.length,
    all: countTab('all'),
    shown: matches.value.length,
    open: countTab('Not started'),
    live: countTab('liveish'),
    ended: countTab('ended'),
  }
})

const filterSummary = computed(() => {
  const parts = []
  if (filter.value === 'Not started') parts.push('未开始')
  else if (filter.value === 'liveish') parts.push('进行中')
  else if (filter.value === 'ended') parts.push('已结束')
  else parts.push('全部状态')
  if (tour.value === 'ATP') parts.push('男子')
  else if (tour.value === 'WTA') parts.push('女子')
  if (pmFilter.value === 'yes') parts.push('有PM')
  else if (pmFilter.value === 'no') parts.push('无PM')
  if (classicRankFiltersOn.value) {
    if (gapMin.value !== 'all') parts.push(`现差≥${gapMin.value}`)
    if (diffMax.value !== 'all') {
      parts.push(diffMax.value === '0' ? '排差<0' : `排差≤${diffMax.value}`)
    }
    if (strongRankMax.value !== 'all') parts.push(`强者现≤${strongRankMax.value}`)
  } else if (isSettledMode.value) {
    if (settledPnlMark.value === 'bet') parts.push('有投注')
    else if (settledPnlMark.value === 'win') parts.push('盈利')
    else if (settledPnlMark.value === 'loss') parts.push('亏损')
  } else if (props.isMember) {
    if (isRangeMode.value) parts.push(RANGE_RULES_TEXT)
    else if (isNewMode.value) parts.push(`Top${topPoolMax.value}`)
  }
  return parts.join(' · ')
})

function sanitizeBundleHint(raw) {
  const msg = String(raw || '').trim()
  if (!msg) return ''
  return msg
    .replace(/sofascore/gi, '')
    .replace(/from\s+monitor\s*→\s*redis/gi, '采集写入 Redis')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 比分 / Polymarket 赔率采集最后更新时间（盘中） */
const collectUpdatedText = computed(() => {
  const scoreAt = fmtRefreshClock(data.value?.score_updated_at || data.value?.tick_at)
  const oddsAt = fmtRefreshClock(data.value?.odds_updated_at || data.value?.tick_at)
  const parts = []
  if (scoreAt) parts.push(`比分 ${scoreAt}`)
  if (oddsAt) parts.push(`赔率 ${oddsAt}`)
  return parts.join(' · ')
})

const bundleHint = computed(() => {
  const msg = data.value?.message || data.value?.update?.message || ''
  return sanitizeBundleHint(msg)
})

/** 条件筛完为空时的说明：采集数 + 条件组名 */
const emptyListHint = computed(() => {
  if (matches.value.length) return ''
  const applied = data.value?.condition_applied === true
  const poolN = Number(data.value?.condition_pool_count)
  const names = Array.isArray(data.value?.condition_group_names)
    ? data.value.condition_group_names.map((n) => String(n || '').trim()).filter(Boolean)
    : []
  const fromRules = Array.isArray(data.value?.admin_condition_rules?.groups)
    ? data.value.admin_condition_rules.groups.map((g, i) => String(g?.name || '').trim() || `条件组 ${i + 1}`)
    : []
  // 回退：本地条件组名（服务端未带回时）
  const localNames = (conditionGroups.value || [])
    .filter((g) => !isPrematchMode.value || g?.linkPrematch === true)
    .map((g, i) => String(g?.name || '').trim() || `条件组 ${i + 1}`)
  const groupNames = names.length ? names : (fromRules.length ? fromRules : localNames)
  const collected = Number.isFinite(poolN) && poolN >= 0
    ? poolN
    : (Number(stats.value?.collected) || Number(stats.value?.total) || 0)

  if (applied || (conditionBucketOn.value && groupNames.length)) {
    const nameText = groupNames.length ? groupNames.join('、') : '当前条件'
    return `采集到 ${collected} 条数据，根据筛选条件「${nameText}」，未获取到符合的数据`
  }
  return `当前筛选下没有场次（池内 ${stats.value.total} 场 · 符合筛选 ${stats.value.shown} 场）`
})

const collectRefreshing = ref(false)
const collectNotice = ref('')
const collectError = ref('')

/** 盘中：触发比分+Polymarket 赔率采集并刷新列表（后台异步，不挡列表操作） */
function refreshScoreOddsCollect() {
  if (collectRefreshing.value) return
  collectRefreshing.value = true
  collectNotice.value = ''
  collectError.value = ''
  void (async () => {
    try {
      let tick = null
      try {
        tick = await api.runTennisInplayTick()
      } catch (e) {
        const msg = e?.response?.data?.error || e?.message || '比分/赔率采集失败'
        if (props.canEditRules || e?.response?.status !== 403) {
          collectError.value = msg
        }
      }
      // 列表后台刷新，不挡交互
      void loadOnce({ quiet: true, deferSideEffects: true })
      if (tick && tick.ok === false && (tick.reason || tick.message)) {
        collectError.value = tick.reason || tick.message
      } else if (tick && !collectError.value) {
        // collect 服务把 tick 结果包在 metrics 里；本机回退则在顶层
        const body = (tick.metrics && typeof tick.metrics === 'object')
          ? { ...tick, ...tick.metrics }
          : tick
        const s = body.scores || {}
        const p = body.prices || {}
        const topErr = body.error || tick.error || ''
        const scoreErr = s.error || s.reason || (s.ok === false ? '比分采集失败' : '')
        const oddsErr = p.error || p.reason || (p.ok === false ? '赔率采集失败' : '')
        const missed = s.summary?.missed || s.missed || body.score_failures || []
        if (scoreErr || oddsErr || topErr) {
          const parts = [scoreErr, oddsErr].filter(Boolean)
          // 顶层错误（如 gamma 超时 / Redis）补一句，避免只显示笼统「采集失败」
          if (topErr && !parts.some((x) => String(x).includes(String(topErr).slice(0, 24)))) {
            parts.push(topErr)
          }
          collectError.value = parts.join(' · ') || String(topErr)
        } else {
          const su = Number(s.updated) || 0
          const pu = Number(p.updated) || 0
          const missHint = Array.isArray(missed) && missed.length
            ? ` · ${missed.length} 场未在 Sofascore live 命中`
            : ''
          collectNotice.value = `已刷新 · 比分 ${su} · 赔率 ${pu}${missHint}`
        }
      }
    } finally {
      collectRefreshing.value = false
    }
  })()
}

function onPolymarketAction(m) {
  // 必须先同步打开：await 采集后再 window.open 会丢掉用户手势，弹窗被浏览器拦截
  openMarket(m)
  if (isInplayMode.value) refreshScoreOddsCollect()
}

function fmtRefreshClock(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function eloOf(id) {
  const map = data.value?.eloByEvent || {}
  return map[id] || map[String(id)] || null
}
function oddsOf(id) {
  const map = data.value?.oddsByEvent || {}
  return map[id] || map[String(id)] || null
}
function polyOf(id) {
  const map = data.value?.polymarketByEvent || {}
  return map[id] || map[String(id)] || null
}

/** 建议投注侧：现排名更高（数字更小）的一侧；缺一方排名则不建议 */
function pickSide(m) {
  if (!m) return null
  const home = m.homePlayer || { name: m.home, ranking: null }
  const away = m.awayPlayer || { name: m.away, ranking: null }
  const homeR = currentRankOf(home)
  const awayR = currentRankOf(away)
  if (homeR == null || awayR == null) return null
  if (homeR === awayR) return null
  return homeR < awayR ? 'home' : 'away'
}

function periodScoreOf(block, i) {
  if (!block || typeof block !== 'object') return null
  const key = `period${i}`
  const setKey = `set${i}`
  const n = Number(block[key] ?? block[setKey] ?? (Array.isArray(block.periods) ? block.periods[i - 1] : null))
  return Number.isFinite(n) ? n : null
}

function isSetCompleteScore(a, b) {
  if (a == null || b == null) return false
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  if (hi >= 6 && hi - lo >= 2) return true
  if (hi >= 7 && lo >= 5) return true
  return false
}

/** 完赛胜方 home|away|null（盘后标记「赢」用） */
function matchWinnerSide(m) {
  if (!m) return null
  const w = String(m.winner || m.winnerCode || m.winner_code || '').toLowerCase()
  if (w === 'home' || w === '1' || w === 'h') return 'home'
  if (w === 'away' || w === '2' || w === 'a') return 'away'
  const hsRaw = m.homeScore ?? m.home_score
  const asRaw = m.awayScore ?? m.away_score
  if (typeof hsRaw === 'number' && typeof asRaw === 'number' && hsRaw !== asRaw) {
    return hsRaw > asRaw ? 'home' : 'away'
  }
  const hs = hsRaw && typeof hsRaw === 'object' ? hsRaw : null
  const as = asRaw && typeof asRaw === 'object' ? asRaw : null
  const displayH = Number(hs?.display ?? hs?.current)
  const displayA = Number(as?.display ?? as?.current)
  if (Number.isFinite(displayH) && Number.isFinite(displayA) && displayH !== displayA) {
    return displayH > displayA ? 'home' : 'away'
  }
  let homeSets = 0
  let awaySets = 0
  for (let i = 1; i <= 5; i++) {
    const h = periodScoreOf(hs, i)
    const a = periodScoreOf(as, i)
    if (h == null || a == null) break
    if (!isSetCompleteScore(h, a)) break
    if (h > a) homeSets += 1
    else if (a > h) awaySets += 1
  }
  if (homeSets !== awaySets) return homeSets > awaySets ? 'home' : 'away'
  return null
}

function matchHomeName(m) {
  return m?.homePlayer?.name || m?.home || '—'
}
function matchAwayName(m) {
  return m?.awayPlayer?.name || m?.away || '—'
}
function listRankOf(m, side) {
  const player = side === 'home'
    ? (m.homePlayer || { name: m.home, ranking: null })
    : (m.awayPlayer || { name: m.away, ranking: null })
  return currentRankOf(player)
}
function listBestOf(m, side) {
  const player = side === 'home'
    ? (m.homePlayer || { name: m.home, ranking: null })
    : (m.awayPlayer || { name: m.away, ranking: null })
  const n = Number(rankDetailOf(player, m).best)
  return Number.isFinite(n) && n > 0 ? n : null
}
function matchGenderLabel(m) {
  const g = m?.gender || m?.homePlayer?.gender || m?.awayPlayer?.gender
  return g === 'F' ? '女子' : '男子'
}
function matchGenderClass(m) {
  const g = m?.gender || m?.homePlayer?.gender || m?.awayPlayer?.gender
  return g === 'F' ? 'gender-f' : 'gender-m'
}
function matchTourTitle(m) {
  const name = String(m?.tournamentShort || m?.tournament || '').replace(/,.*/, '').trim()
  if (!name) return '—'
  return m?.roundLabel ? `${name} · ${m.roundLabel}` : name
}
function levelShort(raw) {
  const s = String(raw || '').trim()
  const lower = s.toLowerCase()
  if (!lower) return ''
  if (lower.includes('grand_slam') || lower.includes('grand slam') || /\bgs\b/.test(lower)) return 'GS'
  if (lower.includes('masters') || /\b1000\b/.test(lower)) return '1000'
  if (/\b500\b/.test(lower)) return '500'
  if (/\b250\b/.test(lower)) return '250'
  return s.replace(/^(atp|wta)\s+/i, '').trim() || s
}
function matchLevelLabel(m) {
  const tour = String(m?.tour || ((m?.gender || m?.homePlayer?.gender || m?.awayPlayer?.gender) === 'F' ? 'wta' : 'atp')).toUpperCase()
  const raw = String(m?.level || '').trim()
  if (!raw) return tour

  // level 已含 ATP/WTA 前缀（如 "ATP GS"）时直接规范化，避免拼成 "ATP ATP GS"
  const prefixed = raw.match(/^(ATP|WTA)\s+(.+)$/i)
  if (prefixed) {
    const prefix = prefixed[1].toUpperCase()
    const short = levelShort(prefixed[2])
    return short && short.toUpperCase() !== prefix ? `${prefix} ${short}` : prefix
  }

  const short = levelShort(raw)
  if (!short || short.toUpperCase() === tour) return tour
  return `${tour} ${short}`
}
function polyUrlOf(m) {
  const url = String(polyOf(m?.id)?.url || '')
  return /polymarket\.com\/event\//i.test(url) ? url : ''
}
function openDetail(m) {
  if (!props.isMember) return
  detailHelpOpen.value = false
  detailMatch.value = m
}
function closeDetail() {
  detailMatch.value = null
  detailHelpOpen.value = false
}
function toggleDetailHelp(ev) {
  ev?.stopPropagation?.()
  detailHelpOpen.value = !detailHelpOpen.value
}
function openMarket(m) {
  if (!props.isMember) return
  const url = polyUrlOf(m)
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  // 与采集端一致：统一按北京时间显示，避免浏览器时区导致“开赛时间不对”
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 开赛日与今天（北京时间）是否同一天 */
function isStartSameDay(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return false
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const startDay = fmt.format(new Date(n * 1000))
  const todayDay = fmt.format(new Date(nowSec.value * 1000))
  return startDay === todayDay
}

function fmtEdge(v) {
  if (v == null || Number.isNaN(Number(v))) return '—'
  const n = Number(v)
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

function fmtOdds(side) {
  // 兼容 { decimal } 与虚拟造数直接给数字
  const d = side != null && typeof side === 'object' ? side.decimal : side
  if (d == null || Number.isNaN(Number(d))) return '—'
  return Number(d).toFixed(2)
}

function oddsSourceLabel(id) {
  const raw = oddsOf(id)?.source || oddsOf(id)?.full_time?.source || ''
  const s = String(raw).trim().toLowerCase()
  if (!s || s.includes('sofa') || s === 'ipwo' || s.includes('monitor')) return ''
  return raw
}

function lastToken(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/)
  return (parts[parts.length - 1] || '').toLowerCase()
}

function polySideCents(poly, homeName, awayName) {
  const ml = poly?.moneyline
  const outcomes = ml?.outcomes || []
  let prices = ml?.prices
  // 虚拟造数：prices 可能是 { home, away } 或顶层 poly.prices
  if (!Array.isArray(prices) && prices && typeof prices === 'object') {
    const home = Number(prices.home)
    const away = Number(prices.away)
    if (Number.isFinite(home) && Number.isFinite(away)) {
      let h = home <= 1 ? Math.round(home * 100) : Math.round(home)
      let a = away <= 1 ? Math.round(away * 100) : Math.round(away)
      const sum = h + a
      if (sum > 0 && sum !== 100) {
        if (h >= a) h += 100 - sum
        else a += 100 - sum
      }
      return { home: h, away: a }
    }
  }
  if ((!Array.isArray(prices) || !prices.length) && poly?.prices && typeof poly.prices === 'object') {
    return polySideCents({ ...poly, moneyline: { ...(ml || {}), prices: poly.prices } }, homeName, awayName)
  }
  prices = Array.isArray(prices) ? prices : []
  if (!outcomes.length || !prices.length) return { home: null, away: null }
  const homeLast = lastToken(homeName)
  const awayLast = lastToken(awayName)
  let homeIdx = outcomes.findIndex((n) => lastToken(n) === homeLast)
  let awayIdx = outcomes.findIndex((n) => lastToken(n) === awayLast)
  if (homeIdx < 0 && awayIdx < 0) { homeIdx = 0; awayIdx = 1 }
  else if (homeIdx < 0) homeIdx = awayIdx === 0 ? 1 : 0
  else if (awayIdx < 0) awayIdx = homeIdx === 0 ? 1 : 0
  const hp = Number(prices[homeIdx])
  const ap = Number(prices[awayIdx])
  if (!Number.isFinite(hp) || !Number.isFinite(ap)) return { home: null, away: null }
  // 独立四舍五入会出现 74.5→75、25.5→26 合计 101；按占比归一到 100
  let home = Math.round(hp * 100)
  let away = Math.round(ap * 100)
  const sum = home + away
  if (sum > 0 && sum !== 100) {
    if (home >= away) home += 100 - sum
    else away += 100 - sum
  }
  return { home, away }
}

function statusText(m) {
  if (isMatchEnded(m)) return '已结束'
  if (isMatchLive(m)) return '进行中'
  const s = effectiveStatus(m)
  if (s === 'Not started') return '未开赛'
  if (s === 'Ended') return '已结束'
  return s || '—'
}

function scoreValue(v) {
  if (v == null || v === '') return null
  if (typeof v === 'object') {
    const cur = v.current ?? v.display ?? v.score
    return cur == null || cur === '' ? null : Number(cur)
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function matchScoreText(m) {
  if (!m || !isMatchLive(m)) return ''
  const hs = playerLiveScoreText(m, 'home')
  const as = playerLiveScoreText(m, 'away')
  if (!hs && !as) return ''
  return `${hs || 0} - ${as || 0}`
}

function parseScoreTextSides(text) {
  if (!text) return null
  const sets = String(text).replace(/,\s*/g, ' ').trim().split(/\s+/).filter(Boolean)
  const home = []
  const away = []
  for (const part of sets) {
    const m = part.match(/^(\d+)-(\d+)$/)
    if (!m) continue
    home.push(m[1])
    away.push(m[2])
  }
  if (!home.length) return null
  // 当前盘 0-0 尚未开打时不显示末尾占位
  if (home.length > 1 && home[home.length - 1] === '0' && away[away.length - 1] === '0') {
    home.pop()
    away.pop()
  }
  if (!home.length) return null
  return { home: home.join(' '), away: away.join(' ') }
}

function parsePeriodScoreSides(m) {
  const hs = m.home_score ?? m.homeScore
  const as = m.away_score ?? m.awayScore
  if (!hs || typeof hs !== 'object' || !as || typeof as !== 'object') return null
  const home = []
  const away = []
  for (const key of ['period1', 'period2', 'period3', 'period4', 'period5']) {
    if (hs[key] != null && as[key] != null) {
      home.push(String(hs[key]))
      away.push(String(as[key]))
    }
  }
  if (!home.length) return null
  return { home: home.join(' '), away: away.join(' ') }
}

function liveSetPairs(m) {
  const combined = m.scoreText || m.score_text || (typeof m.score === 'string' ? m.score : '')
  if (combined) {
    const parts = String(combined).replace(/,\s*/g, ' ').trim().split(/\s+/).filter(Boolean)
    const pairs = []
    for (const part of parts) {
      const hit = part.match(/^(\d+)-(\d+)$/)
      if (!hit) continue
      pairs.push({ home: Number(hit[1]), away: Number(hit[2]) })
    }
    if (pairs.length > 1 && pairs[pairs.length - 1].home === 0 && pairs[pairs.length - 1].away === 0) {
      pairs.pop()
    }
    if (pairs.length) return pairs
  }
  const hs = m.home_score ?? m.homeScore
  const as = m.away_score ?? m.awayScore
  if (!hs || typeof hs !== 'object' || !as || typeof as !== 'object') return []
  const pairs = []
  for (const key of ['period1', 'period2', 'period3', 'period4', 'period5']) {
    if (hs[key] != null && as[key] != null) {
      pairs.push({ home: Number(hs[key]), away: Number(as[key]) })
    }
  }
  return pairs
}

function liveSetCells(m, side) {
  return liveSetPairs(m).map((p) => {
    const mine = side === 'home' ? p.home : p.away
    const opp = side === 'home' ? p.away : p.home
    let cls = 'score-even'
    if (mine > opp) cls = 'score-big'
    else if (mine < opp) cls = 'score-small'
    return { text: String(mine), cls }
  })
}

function livePointText(m, side) {
  const raw = side === 'home' ? (m.home_score ?? m.homeScore) : (m.away_score ?? m.awayScore)
  if (raw && typeof raw === 'object' && raw.point != null && raw.point !== '' && raw.point !== '0') {
    return String(raw.point)
  }
  return ''
}

function playerLiveScoreText(m, side) {
  if (!isMatchLive(m)) return ''
  const combined = m.scoreText || m.score_text || (typeof m.score === 'string' ? m.score : '')
  if (combined) {
    const parsed = parseScoreTextSides(combined)
    if (parsed?.[side]) return parsed[side]
  }
  const periods = parsePeriodScoreSides(m)
  if (periods?.[side]) return periods[side]
  const raw = side === 'home' ? (m.home_score ?? m.homeScore) : (m.away_score ?? m.awayScore)
  if (raw == null || raw === '') return ''
  if (typeof raw === 'object') {
    const cur = raw.current ?? raw.display ?? raw.score
    if (cur != null && cur !== '') return String(cur)
    return ''
  }
  return String(raw)
}

/** 打开页面时从 Redis 加载；quiet 时用于盘中自动轮询 */
async function loadOnce({
  quiet = false,
  skipAutoBatch = false,
  skipStopLoss = false,
  /** 止损/自动买入不挡列表 loading，后台跑 */
  deferSideEffects = false,
} = {}) {
  if (!quiet) {
    error.value = ''
    loading.value = true
  }
  try {
    const token = localStorage.getItem('token') || ''
    const qs = new URLSearchParams()
    if (props.isMember && (isPrematchMode.value || isInplayMode.value || isSettledMode.value)) {
      qs.set('applyCondition', '1')
    }
    if (props.productId != null && props.productId !== '') {
      qs.set('productId', String(props.productId))
    }
    const query = qs.toString()
    const res = await fetch(`${apiPath.value}/today${query ? `?${query}` : ''}`, {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const errBody = await res.json()
        if (errBody?.error) msg = errBody.error
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    const payload = await res.json()
    const bundle =
      payload?.live != null || payload?.scheduled != null || payload?.rankingsByPlayer != null
        ? payload
        : payload?.data || payload
    data.value = bundle
    hydrateConditionFromBundle(bundle)
    if (isInplayMode.value && bundle?.bettingEntry) {
      bettingEntry.value = normalizeInplayBettingEntry(bundle.bettingEntry)
    }
    if (bundle?.serverTime != null) {
      const st = Number(bundle.serverTime)
      serverTimeBase.value = Number.isFinite(st) ? (st > 1e12 ? Math.floor(st / 1000) : Math.floor(st)) : null
      loadedAtMs.value = Date.now()
    } else {
      serverTimeBase.value = Math.floor(Date.now() / 1000)
      loadedAtMs.value = Date.now()
    }
    if (isSettledMode.value) {
      try {
        settledStats.value = await api.fetchTennisSettledStats()
      } catch {
        settledStats.value = null
      }
    } else {
      settledStats.value = null
    }

    // 先结束 loading，列表可交互；止损/自动买放到后面
    if (!quiet) loading.value = false

    const runSideEffects = async () => {
      if (!skipStopLoss) await maybeAutoStopLoss()
      if (!skipAutoBatch) await maybeAutoBatchTrade()
      pruneEndedPlacedOrders()
    }
    if (deferSideEffects || quiet) {
      void runSideEffects().catch(() => { /* 后台失败不挡列表 */ })
    } else {
      await runSideEffects()
    }
  } catch (e) {
    if (!quiet) error.value = e?.message || '加载失败'
  } finally {
    if (!quiet) loading.value = false
  }
}

onMounted(() => {
  loadTennisAutoState()
  if (isPrematchMode.value) {
    tour.value = 'all'
    pmFilter.value = 'all'
    filter.value = 'Not started'
  } else if (isInplayMode.value) {
    tour.value = 'all'
    pmFilter.value = 'all'
    filter.value = 'all'
  } else if (isSettledMode.value) {
    tour.value = 'all'
    pmFilter.value = 'all'
    settledPnlMark.value = 'all'
    filter.value = 'ended'
  } else if (hideEndedEvents.value && filter.value === 'ended') {
    filter.value = 'Not started'
  }

  // 预拉弹窗 chunk，避免第一次点设置再等下载
  void import('./tennis-board/TennisConditionModal.vue')
  void import('./tennis-board/TennisBettingModal.vue')
  void import('./tennis-board/TennisScheduleModal.vue')

  // 赛程数据与引擎配置并行：列表不等 engines / 投注规则
  const dataPromise = loadOnce({ deferSideEffects: true })
  const cfgPromise = Promise.all([
    loadListPollIntervals(),
    loadBettingRules(),
    Promise.resolve().then(() => { loadConditionRules() }),
  ]).catch(() => { /* 配置失败不挡列表 */ })

  void dataPromise.then(() => {
    syncInplayPoll()
  })
  void cfgPromise.then(() => {
    syncInplayPoll()
  })

  tickTimer = setInterval(() => { clockTick.value++ }, 5000)
})

watch(canEditConditionRules, (on) => {
  if (on) loadConditionRules()
})

watch(canEditBettingRules, (on) => {
  if (on) loadBettingRules()
})

watch(bettingBucketKey, () => {
  if (canEditBettingRules.value) loadBettingRules()
})

watch(
  () => [
    data.value?.upstream || data.value?.source || data.value?.dataSource,
    isPrematchMode.value,
    isInplayMode.value,
    isClassicMode.value,
    isSettledMode.value,
  ],
  ([src]) => {
    if (String(src || '') !== 'docks500') return
    if (isPrematchMode.value || isClassicMode.value) {
      if (gapMin.value === '50') gapMin.value = 'all'
      if (diffMax.value === '0') diffMax.value = 'all'
      if (strongRankMax.value === '20') strongRankMax.value = 'all'
    }
    if (isPrematchMode.value && filter.value !== 'Not started' && filter.value !== 'all') {
      filter.value = 'Not started'
    }
    if (isInplayMode.value) {
      filter.value = 'all'
    }
    if (isClassicMode.value && filter.value === 'Not started') {
      filter.value = 'ended'
    }
    if (isSettledMode.value) {
      filter.value = 'ended'
    }
  },
)

watch(
  [tour, pmFilter, gapMin, diffMax, strongRankMax, settledPnlMark],
  () => {
    if (isPrematchMode.value) {
      saveFilters('prematch', {
        tour: tour.value,
        pm: pmFilter.value,
      })
    } else if (isInplayMode.value) {
      saveFilters('inplay', {
        tour: tour.value,
        pm: pmFilter.value,
      })
    } else if (isSettledMode.value) {
      saveFilters('settled', {
        tour: tour.value,
        pm: pmFilter.value,
        pnlMark: settledPnlMark.value,
      })
    }
  },
)
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  clearListPollTimers()
})

function gapInfo(m) {
  if (isInplayMode.value) {
    const metrics = matchInplayRankMetrics(m, data.value?.rankingsByPlayer || {})
    if (!metrics.ready) return { ready: false }
    return {
      ready: true,
      gap: metrics.gap,
      homeR: metrics.homeR,
      awayR: metrics.awayR,
      strongNow: metrics.strongRank,
      minGap: metrics.minGap,
      tier: inplayTierLabel(metrics.strongRank),
    }
  }
  if (isRangeMode.value || isNewMode.value) {
    const metrics = matchRangeMetrics(m, data.value?.rankingsByPlayer || {})
    if (!metrics.ready) return { ready: false }
    return {
      ready: true,
      gap: metrics.gap,
      homeR: metrics.homeR,
      awayR: metrics.awayR,
      strongNow: metrics.strongRank,
      minGap: metrics.minGap,
      tier: tierLabel(metrics.strongRank),
    }
  }
  const home = m.homePlayer || { name: m.home }
  const away = m.awayPlayer || { name: m.away }
  const homeR = currentRankOf(home)
  const awayR = currentRankOf(away)
  if (homeR == null || awayR == null) return { ready: false }
  // 现排名差 = 弱−强；排差 = 强者现排名 − 弱者历史最高
  const gap = Math.max(homeR, awayR) - Math.min(homeR, awayR)
  const homeStronger = homeR < awayR
  const better = homeStronger ? shortName(home.name) : shortName(away.name)
  const strongNow = homeStronger ? homeR : awayR
  const weakNow = homeStronger ? awayR : homeR
  const homeDetail = rankDetailOf(home, m)
  const awayDetail = rankDetailOf(away, m)
  const homeBest = homeDetail.best != null ? Number(homeDetail.best) : null
  const awayBest = awayDetail.best != null ? Number(awayDetail.best) : null
  const strongBest = homeStronger ? homeBest : awayBest
  const weakBest = homeStronger ? awayBest : homeBest
  const hasBest = Number.isFinite(homeBest) && Number.isFinite(awayBest)
  const bestHigh = hasBest ? Math.min(homeBest, awayBest) : null
  const bestLow = hasBest ? Math.max(homeBest, awayBest) : null
  const rankDiff = Number.isFinite(weakBest) ? strongNow - weakBest : null
  return {
    ready: true,
    gap,
    homeR,
    awayR,
    better,
    strongNow,
    weakNow,
    homeBest,
    awayBest,
    bestHigh,
    bestLow,
    strongBest,
    weakBest,
    rankDiff,
  }
}

function settledPnlBadge(m) {
  if (!isSettledMode.value || !m?.id) return null
  const id = String(m.id)
  const stats = settledStats.value
  if (!stats) return null
  const mark = stats.pnlByEvent?.[id]
  const hasBet = stats.betEventIds?.[id] === true || mark != null
  if (mark != null && mark > 0) return { text: '盈', cls: 'pnl-win' }
  if (mark != null && mark < 0) return { text: '亏', cls: 'pnl-loss' }
  if (mark != null && mark === 0) return { text: '平', cls: 'pnl-flat' }
  if (hasBet) return { text: '投', cls: 'pnl-bet' }
  return null
}

defineExpose({
  openConditionModal,
  openBettingModal,
  openScheduleModal,
  sellPlacedOrder,
  clearSoldPlacedOrders,
  getPlacedOrders: () => placedOrders.value.map((r) => ({ ...r })),
})
</script>

<template>
  <div class="wrap">
    <TennisBoardTopbar
      :is-inplay-mode="isInplayMode"
      :is-prematch-mode="isPrematchMode"
      :is-settled-mode="isSettledMode"
      :allow-batch-trade="allowBatchTrade"
      :bundle-hint="bundleHint"
      :collect-updated-text="collectUpdatedText"
      :collect-refreshing="collectRefreshing"
      :collect-notice="collectNotice"
      :collect-error="collectError"
      :refresh-score-odds-collect="refreshScoreOddsCollect"
      :inplay-auto-rules-text="INPLAY_AUTO_RULES_TEXT"
      :settled-stats="settledStats"
      :stats="stats"
      :loading="loading"
      :filter="filter"
      :hide-ended-events="hideEndedEvents"
      :pct="pct"
      :num="num"
      :set-status-filter="setStatusFilter"
    />

    <TennisConditionModal
      v-model:open="conditionModalOpen"
      v-model:condition-bucket-on="conditionBucketOn"
      :condition-bucket-label="conditionBucketLabel"
      :rules-loading="rulesLoading"
      :rules-summary="rulesSummary"
      :can-edit-condition-rules="canEditConditionRules"
      :rules-error="rulesError"
      :rules-notice="rulesNotice"
      :rules-saving="rulesSaving"
      :condition-groups="conditionGroups"
      :is-inplay-mode="isInplayMode"
      :is-prematch-mode="isPrematchMode"
      :set-condition-group-field="setConditionGroupField"
      :remove-condition-group="removeConditionGroup"
      :add-condition-group="addConditionGroup"
      :save-condition-rules="saveConditionRules"
      :open-admin-engine="openAdminEngine"
    />

    <TennisBettingModal
      v-model:open="bettingModalOpen"
      v-model:betting-bucket-on="bettingBucketOn"
      v-model:betting-simulate-on="bettingSimulateOn"
      :is-inplay-mode="isInplayMode"
      :bet-rules-loading="betRulesLoading"
      :select-loading="selectLoading"
      :bet-rules-summary="betRulesSummary"
      :can-edit-betting-rules="canEditBettingRules"
      :betting-entry-norm="bettingEntryNorm"
      :bet-rules-saving="betRulesSaving"
      :bet-rules-error="betRulesError"
      :bet-rules-notice="betRulesNotice"
      :betting-bucket-label="bettingBucketLabel"
      :betting-groups="bettingGroups"
      :ensure-stop-rules="ensureStopRules"
      :open-admin-engine="openAdminEngine"
      :set-betting-entry-field="setBettingEntryField"
      :add-betting-group="addBettingGroup"
      :save-betting-rules="saveBettingRules"
      :set-betting-group-field="setBettingGroupField"
      :remove-betting-group="removeBettingGroup"
      :set-stop-rule-field="setStopRuleField"
      :remove-stop-rule="removeStopRule"
      :add-stop-rule="addStopRule"
    />

    <TennisScheduleModal
      v-model:open="scheduleModalOpen"
      v-model:auto-bet-sec="scheduleDraftAuto"
      v-model:stop-loss-sec="scheduleDraftStop"
      v-model:page-refresh-sec="scheduleDraftPage"
      :saving="scheduleSaving"
      :error="scheduleError"
      :notice="scheduleNotice"
      @save="saveScheduleSettings"
      @open-admin="openScheduleAdmin"
    />

    <TennisBoardFilters
      :is-member="isMember"
      :is-new-mode="isNewMode"
      :show-filters="showFilters"
      :is-prematch-mode="isPrematchMode"
      :is-inplay-mode="isInplayMode"
      :is-settled-mode="isSettledMode"
      :is-range-mode="isRangeMode"
      :classic-rank-filters-on="classicRankFiltersOn"
      :hide-ended-events="hideEndedEvents"
      v-model:top-pool-max="topPoolMax"
      :new-pool-rules-text="NEW_POOL_RULES_TEXT"
      v-model:filters-open="filtersOpen"
      :filter-summary="filterSummary"
      :filter="filter"
      v-model:tour="tour"
      v-model:pm-filter="pmFilter"
      v-model:settled-pnl-mark="settledPnlMark"
      v-model:gap-min="gapMin"
      v-model:diff-max="diffMax"
      v-model:strong-rank-max="strongRankMax"
      :range-rules-text="RANGE_RULES_TEXT"
      :set-status-filter="setStatusFilter"
    />

    <TennisBoardBatchBar
      v-if="showAutoBetBar"
      :allow-batch-trade="allowBatchTrade"
      :auto-sim-bet-enabled="autoSimBetEnabled"
      :page-all-selected="pageAllSelected"
      :page-selectable="pageSelectable"
      :selected-count="selectedCount"
      v-model:batch-amount-usd="batchAmountUsd"
      :show-manual-trade-opts="showManualTradeOpts"
      v-model:manual-order-type="manualOrderType"
      v-model:manual-side="manualSide"
      v-model:manual-shares="manualShares"
      v-model:manual-limit-buy-price="manualLimitBuyPrice"
      :batch-submitting="batchSubmitting"
      :batch-notice="batchNotice"
      :batch-error="batchError"
      :toggle-auto-bet="toggleAutoBet"
      :toggle-select-page="toggleSelectPage"
      :submit-batch-trade="submitBatchTrade"
      :clear-selection="clearSelection"
    />

    <TennisBoardMatchList
      :loading="loading"
      :data="data"
      :error="error"
      :matches="matches"
      :is-inplay-mode="isInplayMode"
      :is-settled-mode="isSettledMode"
      :stats="stats"
      :bundle-hint="bundleHint"
      :empty-list-hint="emptyListHint"
      :allow-batch-trade="allowBatchTrade"
      :paginated-matches="paginatedMatches"
      :auto-placed-ids="autoPlacedIds"
      :is-member="isMember"
      :is-new-mode="isNewMode"
      :is-selected="isSelected"
      :can-select-match="canSelectMatch"
      :toggle-select="toggleSelect"
      :is-start-same-day="isStartSameDay"
      :fmt-time="fmtTime"
      :status-text="statusText"
      :match-tour-title="matchTourTitle"
      :match-gender-class="matchGenderClass"
      :match-gender-label="matchGenderLabel"
      :match-level-label="matchLevelLabel"
      :odds-of="oddsOf"
      :poly-of="polyOf"
      :gap-info="gapInfo"
      :settled-pnl-badge="settledPnlBadge"
      :is-match-live="isMatchLive"
      :pick-side="pickSide"
      :match-winner-side="matchWinnerSide"
      :list-rank-of="listRankOf"
      :list-best-of="listBestOf"
      :match-home-name="matchHomeName"
      :match-away-name="matchAwayName"
      :live-set-cells="liveSetCells"
      :live-point-text="livePointText"
      :open-detail="openDetail"
      :open-market="openMarket"
      :on-polymarket-action="onPolymarketAction"
      :poly-url-of="polyUrlOf"
      :collect-updated-text="collectUpdatedText"
      :collect-refreshing="collectRefreshing"
      :total-pages="totalPages"
      :current-page="currentPage"
      :go-page="goPage"
    />

    <TennisBoardDetailModal
      :detail-match="detailMatch"
      :detail-help-open="detailHelpOpen"
      :detail-tips="DETAIL_TIPS"
      :is-inplay-mode="isInplayMode"
      :is-settled-mode="isSettledMode"
      :is-range-mode="isRangeMode"
      :is-new-mode="isNewMode"
      :short-name="shortName"
      :match-home-name="matchHomeName"
      :match-away-name="matchAwayName"
      :is-start-same-day="isStartSameDay"
      :fmt-time="fmtTime"
      :status-text="statusText"
      :match-level-label="matchLevelLabel"
      :odds-of="oddsOf"
      :poly-of="polyOf"
      :gap-info="gapInfo"
      :pick-side="pickSide"
      :match-winner-side="matchWinnerSide"
      :toggle-detail-help="toggleDetailHelp"
      :close-detail="closeDetail"
      :rank-text="rankText"
      :current-rank-of="currentRankOf"
      :player-live-score-text="playerLiveScoreText"
      :player-name-with-age="playerNameWithAge"
      :elo-of="eloOf"
      :rank-detail-of="rankDetailOf"
      :fmt-edge="fmtEdge"
      :fmt-odds="fmtOdds"
      :odds-source-label="oddsSourceLabel"
      :poly-side-cents="polySideCents"
      :poly-url-of="polyUrlOf"
      :open-market="openMarket"
      :on-polymarket-action="onPolymarketAction"
      :collect-updated-text="collectUpdatedText"
      :collect-refreshing="collectRefreshing"
    />
  </div>
</template>

<style scoped>
.wrap {
  --bg: #f8fafc;
  --card: #ffffff;
  --card-2: #f1f5f9;
  --line: #e2e8f0;
  --text: #1e293b;
  --muted: #94a3b8;
  --primary: #4f46e5;
  --primary-soft: #eef2ff;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  --pink: #db2777;
  color: var(--text);
  background: var(--bg);
  padding: 6px;
  border-radius: 0;
}
</style>
